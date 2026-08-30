import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, RefreshControl, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Plus, Bot } from 'lucide-react-native';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/data-states';
import { StatusBadge } from '@/components/status-badge';
import { IconTile } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import appApi from '@/services/app-api';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';

export default function AgentsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format, plural } = useI18n();
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await appApi.agents.list();
      setAgents(res.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    );
  }, [agents, search]);

  return (
    <Screen
      header={
        <ScreenHeader
          title={t.agents.title}
          actions={
            <IconButton
              icon={<Plus size={20} color={colors.text} />}
              accessibilityLabel={t.agents.createButton}
              onPress={() => router.push('/agent/new')}
            />
          }
          below={
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t.agents.searchPlaceholder}
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.search,
                { color: colors.text, backgroundColor: colors.secondary },
              ]}
            />
          }
        />
      }
    >
      {error && !loading ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={agents.length === 0 ? t.agents.emptyTitle : t.agents.noResultsTitle}
          subtitle={agents.length === 0 ? t.agents.emptySub : undefined}
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />
          }
        >
          {filtered.map((agent) => (
            <RecordRow
              key={agent.id}
              title={agent.name || t.agents.untitled}
              subtitle={agent.description ?? undefined}
              meta={format(t.agents.lastRun, {
                time: formatRelativeTime(agent.lastRunAt, t.relativeTime, format),
              })}
              amount={plural(agent.totalRuns, { one: t.agents.runs, other: t.agents.runs })}
              leading={<IconTile icon={Bot} color={ACCENTS.agents} />}
              badge={<StatusBadge status={agent.status} />}
              onPress={() => router.push(`/agent/${agent.id}`)}
            />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    height: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 15,
  },
});
