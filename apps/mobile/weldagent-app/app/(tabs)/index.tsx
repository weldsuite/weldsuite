import { useCallback, useEffect, useState } from 'react';
import { ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useObserve } from 'expo-observe';
import { MessageSquare, Bot, Sparkles, Plus } from 'lucide-react-native';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/data-states';
import { StatusBadge } from '@/components/status-badge';
import { IconTile } from '@/components/detail';
import { hideAppSplash } from '@/utils/splash';
import { useI18n } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/date';
import { ACCENTS, BRAND } from '@/lib/brand';
import appApi, { type CreditsBalance } from '@/services/app-api';
import type { ConversationSummary } from '@weldsuite/app-api-client/schemas/weldagent';
import type { WorkspaceAgent, WorkspaceAgentRun } from '@weldsuite/app-api-client/schemas/workspace-agents';

type HomeRun = WorkspaceAgentRun & { agentName: string };
type Translations = ReturnType<typeof useI18n>['t'];
type Format = ReturnType<typeof useI18n>['format'];

async function fetchAgentRuns(agent: WorkspaceAgent): Promise<HomeRun[]> {
  try {
    const res = await appApi.agents.listRuns(agent.id, 5);
    return (res.data ?? []).map((run) => ({ ...run, agentName: agent.name }));
  } catch {
    return [];
  }
}

async function fetchRecentRuns(agentList: WorkspaceAgent[]): Promise<HomeRun[]> {
  const runBatches = await Promise.all(agentList.slice(0, 8).map(fetchAgentRuns));
  const merged = runBatches.flat().sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return merged.slice(0, 8);
}

function creditsSubLabel(
  credits: CreditsBalance | null,
  t: Translations,
  format: Format,
): string | undefined {
  if (!credits) return undefined;
  if (credits.isExhausted) return t.home.creditsEmpty;
  if (credits.isLow) return t.home.creditsLow;
  return format(t.home.creditsSub, { count: Math.round(credits.currentBalance) });
}

function RecentChatsSection({
  loading,
  chats,
  onOpen,
}: {
  loading: boolean;
  chats: ConversationSummary[];
  onOpen: (id: string) => void;
}) {
  const { t, format } = useI18n();
  if (loading) return <ListSkeleton count={4} />;
  if (chats.length === 0) {
    return <EmptyState title={t.home.emptyChats} subtitle={t.home.emptyChatsSub} />;
  }
  return (
    <>
      {chats.slice(0, 8).map((chat) => (
        <RecordRow
          key={chat.id}
          title={chat.name}
          subtitle={formatRelativeTime(chat.lastMessageAt, t.relativeTime, format)}
          leading={<IconTile icon={MessageSquare} color={BRAND} />}
          onPress={() => onOpen(chat.id)}
        />
      ))}
    </>
  );
}

function RecentRunsSection({
  loading,
  runs,
  onOpen,
}: {
  loading: boolean;
  runs: HomeRun[];
  onOpen: (agentId: string) => void;
}) {
  const { t, format } = useI18n();
  if (loading) return <ListSkeleton count={3} />;
  if (runs.length === 0) {
    return <EmptyState title={t.home.emptyRuns} subtitle={t.home.emptyRunsSub} />;
  }
  return (
    <>
      {runs.map((run) => (
        <RecordRow
          key={run.id}
          title={run.agentName}
          subtitle={run.result?.summary ?? run.error ?? t.common.dash}
          meta={formatRelativeTime(run.createdAt, t.relativeTime, format)}
          leading={<IconTile icon={run.triggerType === 'chat' ? Sparkles : Bot} color={ACCENTS.activity} />}
          badge={<StatusBadge status={run.status} />}
          onPress={() => onOpen(run.agentId)}
        />
      ))}
    </>
  );
}

export default function HomeScreen() {
  const { markInteractive } = useObserve();
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format } = useI18n();

  const [credits, setCredits] = useState<CreditsBalance | null>(null);
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [runs, setRuns] = useState<HomeRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [creditsRes, chatsRes, agentsRes] = await Promise.all([
        appApi.credits.balance().catch(() => null),
        appApi.weldagent.listConversations(20),
        appApi.agents.list().catch(() => ({ data: [] as WorkspaceAgent[] })),
      ]);
      setCredits(creditsRes?.data ?? null);
      setChats(chatsRes.data ?? []);
      const agentList = agentsRes.data ?? [];
      setAgents(agentList);
      setRuns(await fetchRecentRuns(agentList));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    hideAppSplash();
    markInteractive();
    void load();
  }, [load, markInteractive]);

  const onRefresh = () => {
    setRefreshing(true);
    void load();
  };

  const creditsValue = credits ? String(Math.round(credits.currentBalance)) : t.common.dash;
  const creditsSub = creditsSubLabel(credits, t, format);

  return (
    <Screen
      header={
        <ScreenHeader
          title={t.home.title}
          actions={
            <IconButton
              icon={<Plus size={20} color={colors.text} />}
              accessibilityLabel={t.home.newChat}
              onPress={() => router.push('/chat/new')}
            />
          }
        />
      }
    >
      {error && !loading ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={styles.content}
        >
          {loading ? (
            <KpiSkeletonGrid count={3} />
          ) : (
            <KpiGrid>
              <KpiCard
                label={t.home.credits}
                value={creditsValue}
                sub={creditsSub}
                warn={Boolean(credits?.isExhausted || credits?.isLow)}
                onPress={() => router.push('/credits')}
              />
              <KpiCard
                label={t.tabs.agents}
                value={String(agents.length)}
                onPress={() => router.push('/(tabs)/agents')}
              />
              <KpiCard
                label={t.home.recentChats}
                value={String(chats.length)}
                onPress={() => router.push('/chat/new')}
              />
            </KpiGrid>
          )}

          <SectionLabel>{t.home.newChat}</SectionLabel>
          <RecordRow
            title={t.home.newChat}
            subtitle={t.chat.personalSub}
            leading={<IconTile icon={Sparkles} color={BRAND} />}
            onPress={() => router.push('/chat/new')}
          />
          <RecordRow
            title={t.home.newAgent}
            subtitle={t.agents.emptySub}
            leading={<IconTile icon={Bot} color={ACCENTS.agents} />}
            onPress={() => router.push('/agent/new')}
          />

          <SectionLabel>{t.home.recentChats}</SectionLabel>
          <RecentChatsSection loading={loading} chats={chats} onOpen={(id) => router.push(`/chat/${id}`)} />

          <SectionLabel>{t.home.recentRuns}</SectionLabel>
          <RecentRunsSection loading={loading} runs={runs} onOpen={(id) => router.push(`/agent/${id}`)} />
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
});
