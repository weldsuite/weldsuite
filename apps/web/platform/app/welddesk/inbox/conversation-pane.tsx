import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  deskKeys,
  useDeskConversation,
  useReplyToDeskConversation,
  type DeskMessage,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useDeskConversationRoom } from '@/hooks/welddesk/use-desk-live';
import { useUnifiedNotifications } from '@/contexts/unified-notification-context';
import { ConversationHeader } from './conversation-header';
import { MessagesTimeline } from './messages-timeline';
import { Composer } from './composer';

interface ConversationPaneProps {
  conversationId: string;
}

function newClientId(): string {
  return `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function ConversationPane({ conversationId }: Readonly<ConversationPaneProps>) {
  const t = getTranslations('deskInbox2');
  const qc = useQueryClient();
  const { user } = useUser();
  const { data, isLoading, isError } = useDeskConversation(conversationId);
  const { data: membersData } = useDeskWorkspaceMembers();
  const room = useDeskConversationRoom(conversationId);
  const reply = useReplyToDeskConversation();

  const conversation = data?.data;
  const messages = conversation?.messages ?? [];
  const events = messages.map((m) => m.metadata?.event).filter(Boolean);
  const liveCall =
    conversation?.channel === 'phone' &&
    (events.includes('ai_answered') ||
      events.includes('ai_transcript') ||
      events.includes('call_started')) &&
    !events.includes('call_ended');

  // Phone transcripts are written by the voice agent without a realtime
  // publish, so a live call still polls.
  useEffect(() => {
    if (!liveCall) return;
    const timer = setInterval(() => {
      qc.invalidateQueries({ queryKey: deskKeys.conversationDetail(conversationId) });
    }, 2000);
    return () => clearInterval(timer);
  }, [liveCall, conversationId, qc]);

  // The agent is looking at this thread — its bell notifications are read.
  const { notifications, markAsRead } = useUnifiedNotifications();
  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const n of notifications) {
      if (!n.isRead && n.entityType === 'desk_conversation' && n.entityId === conversationId) {
        void markAsRead(n.id);
      }
    }
  }, [notifications, conversationId, markAsRead]);

  const send = useCallback(
    (kind: 'message' | 'note', body: string, clientId: string = newClientId()) => {
      room.stopTyping();
      reply.mutate(
        { id: conversationId, data: { kind, body }, authorId: user?.id, clientId },
        { onError: () => toast.error(t.composer.replyError) },
      );
    },
    [conversationId, reply, room, t.composer.replyError, user?.id],
  );

  const retry = useCallback(
    (message: DeskMessage) => {
      if (!message.body || message.kind === 'event') return;
      send(message.kind, message.body, message.clientId);
    },
    [send],
  );

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-white dark:bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !conversation) {
    return (
      <div className="h-full flex items-center justify-center bg-white dark:bg-background text-sm text-destructive">
        {t.pane.loadError}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-background overflow-hidden">
      <ConversationHeader
        conversation={conversation}
        liveCall={Boolean(liveCall)}
        visitorOnline={room.visitorOnline}
      />
      <MessagesTimeline
        conversation={conversation}
        messages={messages}
        members={membersData ?? []}
        typing={room.typing}
        onRetry={retry}
      />
      <Composer
        conversationId={conversationId}
        onSend={send}
        onTyping={room.notifyTyping}
        onStopTyping={room.stopTyping}
      />
    </div>
  );
}
