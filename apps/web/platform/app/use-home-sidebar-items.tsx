import * as React from 'react';
import { Home, MessageSquare, Plus, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RenameDialog } from '@/app/weldcrm/components/rename-dialog';
import { useSearchParams, usePathname } from '@/lib/router';
import {
  useDeleteConversation,
  useUpdateConversation,
  useWeldAgentConversations,
  type ConversationSummary,
} from '@/hooks/queries/use-weldagent-queries';

export function useHomeSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const params = useSearchParams();
  const pathname = usePathname();
  const activeConvId = params.get('conversation');
  const isHome = pathname === '/' || pathname === '';
  const isChat = pathname === '/new-chat';

  const { data: conversations = [] } = useWeldAgentConversations(50);
  const updateConvo = useUpdateConversation();
  const deleteConvo = useDeleteConversation();

  const [pendingDelete, setPendingDelete] = React.useState<ConversationSummary | null>(null);
  const [pendingRename, setPendingRename] = React.useState<ConversationSummary | null>(null);

  const menuGroups = React.useMemo<MenuGroupProps[]>(() => {
    const generalGroup: MenuGroupProps = {
      group: 'General',
      items: [
        {
          title: 'Home',
          href: '/',
          icon: Home,
          isActive: isHome,
        },
        {
          title: 'New Chat',
          href: '/new-chat',
          icon: Plus,
          isActive: isChat && !activeConvId,
        },
      ],
    };

    if (!isActive) return [generalGroup];

    const buildItem = (c: ConversationSummary): MenuItemProps => ({
      title: c.name || 'New Chat',
      href: `/new-chat?conversation=${c.id}`,
      icon: MessageSquare,
      id: c.id,
      isActive: c.id === activeConvId,
      actions: [
        {
          label: c.isPinned ? 'Unpin' : 'Pin',
          icon: c.isPinned ? PinOff : Pin,
          onClick: () =>
            updateConvo.mutate({ conversationId: c.id, isPinned: !c.isPinned }),
        },
        {
          label: 'Rename',
          icon: Pencil,
          onClick: () => setPendingRename(c),
        },
        {
          label: 'Delete',
          icon: Trash2,
          onClick: () => setPendingDelete(c),
        },
      ],
    });

    const pinned = conversations.filter((c) => c.isPinned);
    const recent = conversations.filter((c) => !c.isPinned);

    const groups: MenuGroupProps[] = [generalGroup];
    if (pinned.length > 0) {
      groups.push({ group: 'Pinned', items: pinned.map(buildItem) });
    }
    if (recent.length > 0) {
      groups.push({ group: 'Recent', items: recent.map(buildItem) });
    }
    return groups;
  }, [isActive, conversations, activeConvId, isHome, isChat, updateConvo]);

  const dialogs = (
    <>
      <RenameDialog
        open={!!pendingRename}
        onOpenChange={(open) => {
          if (!open) setPendingRename(null);
        }}
        currentName={pendingRename?.name || ''}
        title="Rename chat"
        onRename={(newName) => {
          if (!pendingRename) return;
          updateConvo.mutate({ conversationId: pendingRename.id, name: newName });
          setPendingRename(null);
        }}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete chat?"
        description={
          pendingDelete
            ? `"${pendingDelete.name || 'New Chat'}" and its messages will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteConvo.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await deleteConvo.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </>
  );

  return { menuGroups, dialogs };
}
