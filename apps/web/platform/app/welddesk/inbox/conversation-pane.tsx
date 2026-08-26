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

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-destructive">{t.pane.loadError}</div>
    );
  }

  const conversation = data.data;
  const messages = conversation.messages ?? [];
  const members = membersData ?? [];

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
      <ConversationHeader conversation={conversation} />
      <div className="flex-1 overflow-y-auto p-4">
        <MessagesTimeline messages={messages} members={members} />
      </div>
      <Composer conversationId={conversationId} />
    </div>
  );
}
