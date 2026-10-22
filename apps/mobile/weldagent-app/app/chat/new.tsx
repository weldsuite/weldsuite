import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Sparkles, Bot, Coins } from 'lucide-react-native';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/data-states';
import { IconTile } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import { ACCENTS, BRAND } from '@/lib/brand';
import { TOP_UP_URL, useCreditsBalance } from '@/lib/credits';
import appApi from '@/services/app-api';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';

export default function NewChatScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useI18n();
  const { outOfCredits } = useCreditsBalance();
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await appApi.agents.list('active').catch(() => appApi.agents.list());
      setAgents((res.data ?? []).filter((a) => a.status !== 'draft'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async (agentId?: string) => {
    // Every reply costs credits: don't create an empty conversation that can't be used.
    if (outOfCredits) return;
    const res = await appApi.weldagent.createConversation({
      name: t.chat.newTitle,
      agentId,
    });
    if (res.data?.id) router.replace(`/chat/${res.data.id}`);
  };

  const renderContent = () => {
    if (error) return <ErrorState message={error} onRetry={() => void load()} />;
    if (loading) return <ListSkeleton count={4} />;
    return (
      <ScrollView contentContainerStyle={styles.content}>
        {outOfCredits ? (
          <View style={[styles.creditsNotice, { backgroundColor: colors.secondary }]}>
            <IconTile icon={Coins} color={ACCENTS.credits} />
            <View style={styles.creditsBody}>
              <Text style={[styles.creditsText, { color: colors.text }]}>{t.chat.needsCredits}</Text>
              <Button
                title={t.credits.topUpWeb}
                variant="outline"
                size="sm"
                onPress={() => void Linking.openURL(TOP_UP_URL)}
              />
            </View>
          </View>
        ) : null}

        {/* Dimmed and inert when there are no credits to spend. */}
        <View style={outOfCredits ? styles.disabled : undefined} pointerEvents={outOfCredits ? 'none' : 'auto'}>
          <RecordRow
            title={t.chat.personal}
            subtitle={t.chat.personalSub}
            leading={<IconTile icon={Sparkles} color={BRAND} />}
            onPress={() => void start()}
          />

          <SectionLabel>{t.chat.yourAgents}</SectionLabel>
          {agents.length === 0 ? (
            <View style={styles.empty}>
              <EmptyState title={t.agents.emptyTitle} subtitle={t.agents.emptySub} />
            </View>
          ) : (
            agents.map((agent) => (
              <RecordRow
                key={agent.id}
                title={agent.name}
                subtitle={agent.description ?? t.chat.pickAgent}
                leading={<IconTile icon={Bot} color={ACCENTS.agents} />}
                onPress={() => void start(agent.id)}
              />
            ))
          )}
        </View>
      </ScrollView>
    );
  };

  return (
    <Screen header={<ScreenHeader title={t.chat.newTitle} showBack />}>
      {renderContent()}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  empty: { paddingVertical: 24 },
  disabled: { opacity: 0.5 },
  creditsNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 16,
  },
  creditsBody: { flex: 1, gap: 10, alignItems: 'flex-start' },
  creditsText: { fontSize: 14, lineHeight: 20 },
});
