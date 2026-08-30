import { useCallback, useEffect, useState } from 'react';
import { ScrollView, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Bot, Sparkles } from 'lucide-react-native';

import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/data-states';
import { StatusBadge } from '@/components/status-badge';
import { IconTile } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/date';
import { ACCENTS } from '@/lib/brand';
import appApi from '@/services/app-api';
import type { WorkspaceAgent, WorkspaceAgentRun } from '@weldsuite/app-api-client/schemas/workspace-agents';

export default function ActivityScreen() {
  const router = useRouter();
  const { t, format } = useI18n();
  const [runs, setRuns] = useState<Array<WorkspaceAgentRun & { agentName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerLabel = (type: string | null) => {
    if (type === 'event') return t.activity.triggerEvent;
    if (type === 'chat') return t.activity.triggerChat;
    return t.activity.triggerManual;
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const agentsRes = await appApi.agents.list();
      const agents: WorkspaceAgent[] = agentsRes.data ?? [];
      const batches = await Promise.all(
        agents.map(async (agent) => {
          try {
            const res = await appApi.agents.listRuns(agent.id, 20);
            return (res.data ?? []).map((run) => ({ ...run, agentName: agent.name }));
          } catch {
            return [];
          }
        }),
      );
      setRuns(batches.flat().sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1)).slice(0, 50));
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

  return (
    <Screen header={<ScreenHeader title={t.activity.title} />}>
      {error && !loading ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <ListSkeleton />
      ) : runs.length === 0 ? (
        <EmptyState title={t.activity.emptyTitle} subtitle={t.activity.emptySub} />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />
          }
        >
          {runs.map((run) => (
            <RecordRow
              key={run.id}
              title={run.agentName}
              subtitle={run.result?.summary ?? run.error ?? t.common.dash}
              meta={`${triggerLabel(run.triggerType)} · ${formatRelativeTime(run.createdAt, t.relativeTime, format)}`}
              leading={
                <IconTile
                  icon={run.triggerType === 'chat' ? Sparkles : Bot}
                  color={ACCENTS.activity}
                />
              }
              badge={<StatusBadge status={run.status} />}
              onPress={() => router.push(`/agent/${run.agentId}`)}
            />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
