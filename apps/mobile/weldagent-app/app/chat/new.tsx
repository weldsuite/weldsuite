import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Sparkles, Bot } from 'lucide-react-native';

import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/data-states';
import { IconTile } from '@/components/detail';
import { useI18n } from '@/lib/i18n';
import { ACCENTS, BRAND } from '@/lib/brand';
import appApi from '@/services/app-api';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';

export default function NewChatScreen() {
  const router = useRouter();
  const { t } = useI18n();
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
    const res = await appApi.weldagent.createConversation({
      name: t.chat.newTitle,
      agentId,
    });
    if (res.data?.id) router.replace(`/chat/${res.data.id}`);
  };

  return (
    <Screen header={<ScreenHeader title={t.chat.newTitle} showBack />}>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <ListSkeleton count={4} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <RecordRow
            title={t.chat.personal}
            subtitle={t.chat.personalSub}
            leading={<IconTile icon={Sparkles} color={BRAND} />}
            onPress={() => void start()}
          />
          {agents.length === 0 ? (
            <EmptyState title={t.agents.emptyTitle} subtitle={t.agents.emptySub} />
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
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
});
