/**
 * Password health: weak, reused and old passwords in the vaults the person
 * can open. The server works it out (`/password-health`) without sending a
 * password; this screen lists what needs fixing, worst first.
 */

import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import type { WeldPassPasswordIssue } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ItemIcon } from '@/components/ItemIcon';
import { Screen } from '@/components/Screen';
import { usePasswordHealth } from '@/hooks/use-passwords';
import { STRENGTH_COLORS } from '@/lib/brand';
import { passErrorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n';

const ISSUE_COLORS: Record<WeldPassPasswordIssue, string> = {
  weak: STRENGTH_COLORS.weak,
  reused: STRENGTH_COLORS.fair,
  old: '#6B7280',
};

export default function HealthScreen() {
  const { t, format, plural } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const health = usePasswordHealth();
  const report = health.data;

  let empty = null;
  if (health.isLoading) {
    empty = (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  } else if (health.error) {
    empty = <EmptyState title={passErrorMessage(t, health.error)} />;
  } else if (report && report.checked === 0) {
    empty = <EmptyState title={t.health.nothingChecked} />;
  } else if (report) {
    empty = (
      <EmptyState
        icon={<ShieldCheck size={32} color={STRENGTH_COLORS.strong} />}
        title={t.health.allGood}
        description={t.health.allGoodDescription}
      />
    );
  }

  const counts: { issue: WeldPassPasswordIssue; count: number }[] = report
    ? [
        { issue: 'weak', count: report.weak },
        { issue: 'reused', count: report.reused },
        { issue: 'old', count: report.old },
      ]
    : [];

  return (
    <Screen title={t.health.title} back>
      <FlatList
        data={report?.items ?? []}
        keyExtractor={(entry) => entry.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={health.isRefetching} onRefresh={() => void health.refetch()} />}
        ListHeaderComponent={
          report && report.checked > 0 ? (
            <View style={styles.summary}>
              <Text style={[styles.summaryText, { color: colors.text }]}>
                {format(t.health.summary, { healthy: report.healthy, checked: report.checked })}
              </Text>
              <View style={styles.counts}>
                {counts.map(({ issue, count }) => (
                  <View key={issue} style={[styles.count, { backgroundColor: colors.secondary }]}>
                    <Text style={[styles.countNumber, { color: ISSUE_COLORS[issue] }]}>{count}</Text>
                    <Text style={[styles.countLabel, { color: colors.mutedForeground }]}>{t.health[issue]}</Text>
                  </View>
                ))}
              </View>
              {report.items.length > 0 ? (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.health.fixHint}</Text>
              ) : null}
            </View>
          ) : null
        }
        ListEmptyComponent={empty}
        renderItem={({ item: entry }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/item/[vaultId]/[itemId]', params: { vaultId: entry.vaultId, itemId: entry.id } })}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}
          >
            <ItemIcon type={entry.type} />
            <View style={styles.text}>
              <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                {entry.title}
              </Text>
              <View style={styles.issues}>
                {entry.issues.map((issue) => (
                  <Text key={issue} style={[styles.issue, { color: ISSUE_COLORS[issue] }]}>
                    {issue === 'reused' && entry.reuseCount > 1
                      ? plural(entry.reuseCount - 1, t.health.reusedCount)
                      : t.health[issue]}
                  </Text>
                ))}
              </View>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 48, flexGrow: 1 },
  center: { paddingTop: 48, alignItems: 'center' },
  summary: { paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  summaryText: { fontSize: 17, fontWeight: '600' },
  counts: { flexDirection: 'row', gap: 10 },
  count: { flex: 1, borderRadius: 12, padding: 12, gap: 2 },
  countNumber: { fontSize: 24, fontWeight: '700' },
  countLabel: { fontSize: 13 },
  hint: { fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, gap: 4 },
  title: { fontSize: 16, fontWeight: '600' },
  issues: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  issue: { fontSize: 13, fontWeight: '500' },
});
