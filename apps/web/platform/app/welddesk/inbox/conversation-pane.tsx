import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { deskKeys, useDeskConversation } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useWeldDeskRealtime } from '@/hooks/welddesk/use-welddesk-realtime';
import { ConversationHeader } from './conversation-header';
import { MessagesTimeline } from './messages-timeline';
import { Composer } from './composer';

interface ConversationPaneProps {
  conversationId: string;
}

export function ConversationPane({ conversationId }: ConversationPaneProps) {
  const t = getTranslations('deskInbox2');
  const qc = useQueryClient();
  const { data, isLoading, isError } = useDeskConversation(conversationId);
  const { data: membersData } = useDeskWorkspaceMembers();

  useWeldDeskRealtime({
    conversationId,
    role: 'agent',
    enabled: true,
    onMessage: () => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
    onEvent: () => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) });
      qc.invalidateQueries({ queryKey: deskKeys.conversations() });
    },
  });

  const conversation = data?.data;
  const messages = conversation?.messages ?? [];
  const events = messages.map((m) => m.metadata?.event).filter(Boolean);
  const liveCall =
    conversation?.channel === 'phone' &&
    (events.includes('ai_answered') ||
      events.includes('ai_transcript') ||
      events.includes('call_started')) &&
    !events.includes('call_ended');

  useEffect(() => {
    if (!liveCall) return;
    const timer = setInterval(() => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) });
    }, 2000);
    return () => clearInterval(timer);
  }, [liveCall, conversationId, qc]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-white dark:bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="h-full flex items-center justify-center bg-white dark:bg-background text-sm text-destructive">
        {t.pane.loadError}
      </div>
    );
  }

  const members = membersData ?? [];
  const current = data.data;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-background overflow-hidden">
      <ConversationHeader conversation={current} liveCall={Boolean(liveCall)} />
      <div className="flex-1 overflow-y-auto">
        <MessagesTimeline messages={current.messages ?? []} members={members} />
      </div>
      <Composer conversationId={conversationId} />
    </div>
  );
}
