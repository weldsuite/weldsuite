
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@weldsuite/ui/components/context-menu';

function conversationToItem(conv: Helpdesk.Conversation): ConversationItem {
  return {
    id: conv.id,
    name: conv.customerName || conv.customerEmail || 'Unknown Customer',
    email: conv.customerEmail,
    subject: conv.subject || 'No subject',
    preview: conv.preview || conv.lastMessage || '',
    date: new Date(conv.lastMessageAt || conv.createdAt),
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    labels: [],
    messageCount: 1,
    unreadCount: 0,
  };
}

interface ArchivedListClientProps {
  initialConversations: Helpdesk.Conversation[];
}

export default function ArchivedListClient({ initialConversations }: ArchivedListClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const { getClient } = useAppApiClient();
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Archived' },
  ]);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<string | null>(null);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const selectedConversationId = pathname.split('/').pop();

  const items = useMemo(() => conversations.map(conversationToItem), [conversations]);

  const handleItemClick = (item: ConversationItem) => {
    router.push(`/welddesk/inbox/archived/${item.id}`);
  };

  const handleUnarchive = async (conversationId: string) => {
    try {
      const client = await getClient();
      // Unarchive is a plain isArchived write. The legacy call POSTed to
      // /unarchive, which never existed on api-worker (it only ever had
      // PATCH /:id/archive) — so restoring has been 404ing.
      await client.patch(`/conversations/${conversationId}`, { isArchived: false });
      setConversations(prev => prev.filter(conv => conv.id !== conversationId));
      toast.success(ti.conversationRestoredToInbox);
      if (selectedConversationId === conversationId) {
        router.push('/welddesk/inbox/archived');
      }
    } catch {
      toast.error(ti.failedToRestoreConversation);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!conversationToDelete) return;
    setShowDeleteDialog(false);
    try {
      const client = await getClient();
      // app-api DELETE returns 204 No Content — non-2xx throws, so the catch
      // below is the only failure path (no {success} flag to gate on).
      await client.delete<void>(`/conversations/${conversationToDelete}`);
      setConversations(prev => prev.filter(conv => conv.id !== conversationToDelete));
      toast.success(ti.conversationDeletedPermanently);
      if (selectedConversationId === conversationToDelete) {
        router.push('/welddesk/inbox/archived');
      }
    } catch {
      toast.error(ti.failedToDeleteConversation);
    }
    setConversationToDelete(null);
  };

  const getContextMenu = (item: ConversationItem) => {
    return (
      <>
        <ContextMenuItem onClick={() => handleUnarchive(item.id)}>
          <ArchiveRestore className="h-4 w-4 mr-0.5" />
          {ti.restoreToInbox}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-red-600 focus:text-red-600 focus:bg-red-50 hover:bg-red-50"
          onClick={() => {
            setConversationToDelete(item.id);
            setShowDeleteDialog(true);
          }}
        >
          <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
          {ti.deletePermanently}
        </ContextMenuItem>
      </>
    );
  };

  return (
    <>
      <ConversationList
        items={items}
        selectedId={selectedConversationId}
        getItemUrl={(item) => `/welddesk/inbox/archived/${item.id}`}
        onItemClick={handleItemClick}
        contextMenuItems={getContextMenu}
        emptyMessage={ti.noArchivedConversations}
      />

      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          setShowDeleteDialog(open);
          if (!open) setConversationToDelete(null);
        }}
        title={ti.deleteConversationPermanently}
        description={ti.deleteConversationDescription}
        confirmLabel={ti.deletePermanently}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
