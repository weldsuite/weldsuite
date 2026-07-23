import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { useDeskConversation, useUpdateDeskConversationAttributes } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { ConversationHeader } from './conversation-header';
import { PartsTimeline } from './parts-timeline';
import { Composer } from './composer';
import { DetailsPanel } from './details-panel';
import { CommandBar } from './command-bar';
import { useInboxHotkeys } from './use-inbox-hotkeys';

interface ConversationPaneProps {
  conversationId: string;
  onSelectConversation: (id: string) => void;
  onEscapeToList?: () => void;
}

/**
 * Full Intercom-style conversation pane: header (assign/snooze/close/
 * priority/tags), parts timeline (messages + inline events + Block Kit),
 * composer (reply/note + macros + @mentions), and the right details panel.
 * Also owns the inbox-scoped keyboard shortcuts + local Cmd+K command bar
 * (see .claude/welddesk-intercom-plan.md Phase 2).
 */
export function ConversationPane({ conversationId, onSelectConversation, onEscapeToList }: ConversationPaneProps) {
  const t = getTranslations('deskInbox2');
  const { data, isLoading, isError } = useDeskConversation(conversationId);
  const { data: membersData } = useDeskWorkspaceMembers();
  const updateAttributes = useUpdateDeskConversationAttributes();

  const [assignOpen, setAssignOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [commandBarOpen, setCommandBarOpen] = useState(false);

  // ConversationHeader owns the close/reopen mutation (so its button and the
  // Shift+C hotkey share one code path); it hands us a fresh closure on
  // every render via onToggleCloseHandlerReady.
  const toggleCloseRef = useRef<() => void>(() => {});

  const conversation = data?.data;

  // Mark read on open if unread — the list invalidation (stage 1) clears the
  // unread dot optimistically via useUpdateDeskConversationAttributes.
  useEffect(() => {
    if (conversation && !conversation.read) {
      updateAttributes.mutate({ id: conversation.id, data: { read: true } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.read]);

  useInboxHotkeys({
    hasConversation: !!conversation,
    onAssign: () => setAssignOpen(true),
    onSnooze: () => setSnoozeOpen(true),
    onToggleClose: () => toggleCloseRef.current(),
    onCommandBar: () => setCommandBarOpen((v) => !v),
    onEscapeToList,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !conversation) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-destructive">{t.pane.loadError}</div>
    );
  }

  const parts = data?.data.parts ?? [];
  const members = membersData ?? [];

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        <ConversationHeader
          conversation={conversation}
          assignPopoverOpen={assignOpen}
          onAssignPopoverOpenChange={setAssignOpen}
          snoozePopoverOpen={snoozeOpen}
          onSnoozePopoverOpenChange={setSnoozeOpen}
          onToggleCloseHandlerReady={(handler) => {
            toggleCloseRef.current = handler;
          }}
        />
        <div className="flex-1 overflow-y-auto p-4">
          <PartsTimeline parts={parts} members={members} />
        </div>
        <Composer conversationId={conversationId} />
      </div>
      <DetailsPanel conversation={conversation} onSelectConversation={onSelectConversation} />
      <CommandBar
        open={commandBarOpen}
        onOpenChange={setCommandBarOpen}
        conversation={conversation}
        onRequestAssign={() => setAssignOpen(true)}
        onRequestSnooze={() => setSnoozeOpen(true)}
      />
    </div>
  );
}
