import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@/lib/auth';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  deskKeys,
  useDeskConversation,
  useReplyToDeskConversation,
  type DeskMessage,
  type DeskMessageAttachment,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useDeskConversationRoom } from '@/hooks/welddesk/use-desk-live';
import { useUnifiedNotifications } from '@/contexts/unified-notification-context';
import { ConversationHeader } from './conversation-header';
import { MessagesTimeline } from './messages-timeline';
import { Composer } from './composer';
import { CustomerPanel } from './customer-panel';

interface ConversationPaneProps {
  conversationId: string;
}

function newClientId(): string {
  return `tmp_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
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
  const events = new Set(messages.map((m) => m.metadata?.event).filter(Boolean));
  const liveCall =
    conversation?.channel === 'phone' &&
    (events.has('ai_answered') ||
      events.has('ai_transcript') ||
      events.has('call_started')) &&
    !events.has('call_ended');

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
    (
      kind: 'message' | 'note',
      body: string,
      attachments?: DeskMessageAttachment[],
      clientId: string = newClientId(),
    ) => {
      room.stopTyping();
      reply.mutate(
        { id: conversationId, data: { kind, body, attachments }, authorId: user?.id, clientId },
        { onError: () => toast.error(t.composer.replyError) },
      );
    },
    [conversationId, reply, room, t.composer.replyError, user?.id],
  );

  const retry = useCallback(
    (message: DeskMessage) => {
      if (message.kind === 'event' || (!message.body && !message.attachments?.length)) return;
      send(message.kind, message.body ?? '', message.attachments ?? undefined, message.clientId);
    },
    [send],
  );

  const savedReplyVariables = useMemo(
    () => ({
      customer: {
        name: conversation?.name ?? '',
        firstName: conversation?.name?.split(/\s+/)[0] ?? '',
        email: conversation?.email ?? '',
      },
      conversation: { number: conversation?.conversationNumber ?? '' },
      agent: { name: user?.fullName ?? '', firstName: user?.firstName ?? '' },
    }),
    [conversation?.name, conversation?.email, conversation?.conversationNumber, user?.fullName, user?.firstName],
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
    <div className="h-full flex bg-white dark:bg-background overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col">
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
          savedReplyVariables={savedReplyVariables}
          onSend={send}
          onTyping={room.notifyTyping}
          onStopTyping={room.stopTyping}
        />
      </div>
      <CustomerPanel conversation={conversation} members={membersData ?? []} />
    </div>
  );
}
