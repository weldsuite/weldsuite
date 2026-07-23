
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
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
import { useHelpdeskWebSocket } from '@/hooks/helpdesk/use-helpdesk-websocket';
import { useI18n } from '@/lib/i18n/provider';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import {
  ContextMenuItem,
} from '@weldsuite/ui/components/context-menu';
import { Star } from 'lucide-react';

type FilterType = 'all' | 'unread' | 'starred' | 'urgent' | 'active';

function conversationToItem(conv: Helpdesk.Conversation): ConversationItem {
  return {
    id: conv.id,
    name: conv.customerEmail || conv.customerName || 'Unknown Sender',
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

interface EmailListClientProps {
  initialConversations: Helpdesk.Conversation[];
  accessToken?: string;
}

export default function EmailListClient({ initialConversations, accessToken }: EmailListClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const { getClient } = useAppApiClient();
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Email' },
  ]);

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const { isConnected } = useHelpdeskWebSocket({
    isAgent: true,
    accessToken,
    onNewConversation: (newConversation) => {
      if (newConversation.channel !== 'email') return;
      if (newConversation.assigneeName === 'weldagent-system') return;
      setConversations(prev => [newConversation as Helpdesk.Conversation, ...prev]);
      toast.success(ti.newEmail, {
        description: ti.newEmailDescription,
      });
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(ti.newEmail, { body: ti.newEmailDescription, icon: '/favicon.ico' });
      }
    },
    onAgentAssigned: (data) => {
      setConversations(prev => prev.map(conv =>
        conv.id === data.conversationId ? { ...conv, assigneeId: data.agentId, assigneeName: data.agentName } : conv
      ));
      if (data.agentName !== 'weldagent-system') {
        if (!conversations.some(c => c.id === data.conversationId)) loadConversations();
        toast.info(ti.conversationAssigned, { description: ti.conversationAssignedTo.replace('{name}', data.agentName) });
      }
    },
  });

  const selectedConversationId = pathname.split('/').pop();

  const loadConversations = async () => {
    try {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/conversations?limit=50&channel=email');
      if (result.data) setConversations(result.data as Helpdesk.Conversation[]);
    } catch { /* ignore */ }
  };

  const filteredConversations = conversations.filter(conv => {
    if (conv.assigneeName === 'weldagent-system') return false;
    switch (activeFilter) {
      case 'unread': return !conv.isRead;
      case 'starred': return conv.isStarred === true;
      case 'urgent': return conv.priority === 'urgent' || conv.priority === 'critical';
      case 'active': return conv.status === 'active';
      default: return true;
    }
  });

  const items = useMemo(() => filteredConversations.map(conversationToItem), [filteredConversations]);

  const handleItemClick = async (item: ConversationItem) => {
    const conversation = conversations.find(c => c.id === item.id);
    if (conversation && !conversation.isRead) {
      setConversations(prev => prev.map(c => c.id === item.id ? { ...c, isRead: true } : c));
      try {
        const client = await getClient();
        // /read zeroes unreadCount server-side.
        await client.patch(`/conversations/${item.id}/read`, { isRead: true });
      } catch { /* ignore */ }
    }
    router.push(`/welddesk/inbox/email/${item.id}`);
  };

  const handleToggleStar = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: !conv.isStarred } : c));
    try {
      const client = await getClient();
      // Sends the TOGGLED value; non-2xx throws, so the catch is the rollback.
      await client.patch(`/conversations/${id}/star`, { isStarred: !conv.isStarred });
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
          className={cn('h-8 text-sm px-3 shadow-none gap-1.5', activeFilter !== 'all' ? 'text-foreground' : 'text-muted-foreground')}
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
          {(['all', 'unread', 'starred', 'urgent', 'active'] as FilterType[]).map((value) => (
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
      getItemUrl={(item) => `/welddesk/inbox/email/${item.id}`}
      onItemClick={handleItemClick}
      filterContent={filterContent}
      onToggleStar={handleToggleStar}
      contextMenuItems={getContextMenu}
      emptyMessage={ti.noEmailConversations}
    />
  );
}
