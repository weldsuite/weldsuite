import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking } from 'react-native';
import { Coins } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, IconTile } from '@/components/detail';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { ErrorState } from '@/components/data-states';
import { useI18n } from '@/lib/i18n';
import { ACCENTS } from '@/lib/brand';
import appApi, { type CreditsBalance } from '@/services/app-api';

const TOP_UP_URL = 'https://app.weldsuite.org';

export default function CreditsScreen() {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const [credits, setCredits] = useState<CreditsBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await appApi.credits.balance();
      setCredits(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen header={<ScreenHeader title={t.credits.title} showBack />}>
      {error && !credits ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {loading || !credits ? (
            <KpiSkeletonGrid count={2} />
          ) : (
            <KpiGrid>
              <KpiCard
                label={t.credits.balance}
                value={String(Math.round(credits.currentBalance))}
                sub={format(t.credits.remaining, { count: Math.round(credits.currentBalance) })}
                warn={credits.isExhausted || credits.isLow}
              />
              <KpiCard
                label={t.credits.allocation}
                value={String(Math.round(credits.monthlyAllocation))}
                sub={format(t.credits.used, { percent: Math.round(credits.usagePercentage) })}
              />
            </KpiGrid>
          )}

          <SectionCard title={t.credits.title}>
            <View style={styles.lead}>
              <IconTile icon={Coins} color={ACCENTS.credits} />
              <Text style={[styles.leadText, { color: colors.mutedForeground }]}>
                {credits?.isExhausted
                  ? t.credits.exhausted
                  : credits?.isLow
                    ? t.credits.low
                    : t.credits.topUpHint}
              </Text>
            </View>
            {credits ? (
              <>
                <DetailRow
                  label={t.credits.balance}
                  value={String(Math.round(credits.currentBalance))}
                  strong
                />
                <DetailRow
                  label={t.credits.allocation}
                  value={String(Math.round(credits.monthlyAllocation))}
                />
                <DetailRow
                  label={t.home.credits}
                  value={format(t.credits.daysRemaining, { count: credits.daysRemaining })}
                />
              </>
            ) : null}
            <Button
              title={t.credits.topUpWeb}
              variant="outline"
              onPress={() => void Linking.openURL(TOP_UP_URL)}
              style={styles.topUp}
            />
          </SectionCard>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  lead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  leadText: { flex: 1, fontSize: 14, lineHeight: 20 },
  topUp: { marginTop: 16 },
});
