
import { useState, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Toggle } from '@weldsuite/ui/components/toggle';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import {
  ContextMenuItem,
} from '@weldsuite/ui/components/context-menu';
import { Star } from 'lucide-react';

type FilterType = 'all' | 'unread' | 'starred' | 'urgent' | 'active';

const FILTERS: FilterType[] = ['all', 'unread', 'starred', 'urgent', 'active'];

/** Assignee name WeldAgent uses while it is still handling a conversation itself. */
export const WELDAGENT_ASSIGNEE = 'weldagent-system';

/**
 * Maps a conversation to a list row. `nameFirst` picks whether the customer's
 * name or e-mail address leads, `fallbackName` is shown when both are empty.
 */
export function conversationToItem(
  conv: Helpdesk.Conversation,
  nameFirst: boolean,
  fallbackName: string,
): ConversationItem {
  const name = nameFirst
    ? conv.customerName || conv.customerEmail
    : conv.customerEmail || conv.customerName;
  return {
    id: conv.id,
    name: name || fallbackName,
    email: conv.customerEmail,
    subject: conv.subject || 'No subject',
    preview: conv.preview || conv.lastMessage || '',
    date: new Date(conv.lastMessageAt || conv.createdAt),
    isRead: conv.isRead,
    isStarred: conv.isStarred,
    hasAttachments: false,
    labels: conv.labels || [],
    messageCount: 1,
    unreadCount: conv.isRead ? 0 : 1,
  };
}

interface InboxConversationListProps {
  conversations: Helpdesk.Conversation[];
  setConversations: Dispatch<SetStateAction<Helpdesk.Conversation[]>>;
  toItem: (conv: Helpdesk.Conversation) => ConversationItem;
  itemUrl: (id: string) => string;
  emptyMessage: string;
  /** Hide conversations WeldAgent is still handling. */
  hideAgentHandled: boolean;
  /**
   * `action-routes` marks read/starred through PATCH /:id/read and /:id/star
   * (/read also zeroes unreadCount server-side); `generic` uses the plain
   * PATCH /:id, which writes exactly what it is given.
   */
  updateMode: 'action-routes' | 'generic';
  /** Runs after an unread conversation is opened and marked read. */
  onMarkedRead?: () => void;
}

/** Filterable, starrable conversation list shared by the channel and team inboxes. */
export function InboxConversationList({
  conversations,
  setConversations,
  toItem,
  itemUrl,
  emptyMessage,
  hideAgentHandled,
  updateMode,
  onMarkedRead,
}: Readonly<InboxConversationListProps>) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const { getClient } = useAppApiClient();
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  const selectedConversationId = pathname.split('/').pop();

  const filteredConversations = conversations.filter(conv => {
    if (hideAgentHandled && conv.assigneeName === WELDAGENT_ASSIGNEE) return false;
    switch (activeFilter) {
      case 'unread': return !conv.isRead;
      case 'starred': return conv.isStarred === true;
      case 'urgent': return conv.priority === 'urgent' || conv.priority === 'critical';
      case 'active': return conv.status === 'active';
      default: return true;
    }
  });

  const items = useMemo(() => filteredConversations.map((conv) => toItem(conv)), [filteredConversations, toItem]);

  const handleItemClick = async (item: ConversationItem) => {
    const conversation = conversations.find(c => c.id === item.id);
    if (conversation && !conversation.isRead) {
      setConversations(prev => prev.map(c => c.id === item.id ? { ...c, isRead: true } : c));
      try {
        const client = await getClient();
        if (updateMode === 'action-routes') {
          await client.patch(`/conversations/${item.id}/read`, { isRead: true });
        } else {
          await client.patch(`/conversations/${item.id}`, { isRead: true, unreadCount: 0 });
        }
      } catch { /* ignore */ }
      onMarkedRead?.();
    }
    router.push(itemUrl(item.id));
  };

  const handleToggleStar = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: !conv.isStarred } : c));
    try {
      const client = await getClient();
      // Sends the TOGGLED value; non-2xx throws, so the catch is the rollback.
      const path = updateMode === 'action-routes' ? `/conversations/${id}/star` : `/conversations/${id}`;
      await client.patch(path, { isStarred: !conv.isStarred });
    } catch {
      setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: conv.isStarred } : c));
      toast.error(ti.failedToUpdateStarStatus);
    }
  };

  const getContextMenu = (item: ConversationItem) => {
    const conv = conversations.find(c => c.id === item.id);
    if (!conv) return null;
    return (
      <ContextMenuItem onClick={() => handleToggleStar(item.id)}>
        <Star className={cn('h-4 w-4 mr-0.5', conv.isStarred && 'text-yellow-500 fill-yellow-500')} />
        {conv.isStarred ? ti.unstar : ti.star}
      </ContextMenuItem>
    );
  };

  const filterLabels: Record<FilterType, string> = {
    all: ti.all,
    unread: ti.filters.unread,
    starred: ti.filters.starred,
    urgent: ti.filters.urgent,
    active: ti.filters.active,
  };

  const filterContent = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 text-sm px-3 shadow-none gap-1.5', activeFilter === 'all' ? 'text-muted-foreground' : 'text-foreground')}
        >
          {ti.filters.filter}
          {activeFilter !== 'all' && (
            <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">1</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">{ti.status}</p>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((value) => (
            <Toggle
              key={value}
              size="sm"
              variant="outline"
              pressed={activeFilter === value}
              onPressedChange={() => setActiveFilter(value)}
              className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary capitalize"
            >
              {filterLabels[value]}
            </Toggle>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <ConversationList
      items={items}
      selectedId={selectedConversationId}
      getItemUrl={(item) => itemUrl(item.id)}
      onItemClick={handleItemClick}
      filterContent={filterContent}
      onToggleStar={handleToggleStar}
      contextMenuItems={getContextMenu}
      emptyMessage={emptyMessage}
    />
  );
}
