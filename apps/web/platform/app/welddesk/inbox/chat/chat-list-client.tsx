
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useQueryClient } from '@tanstack/react-query';
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
import { helpdeskExtraKeys } from '@/hooks/queries/use-helpdesk-queries';
import { useHelpdeskWebSocket } from '@/hooks/helpdesk/use-helpdesk-websocket';
import { decrementHelpdeskBadge } from '@/hooks/use-sidebar-badges';
import { showBrowserNotification } from '@/lib/utils/notification-sound';
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
    name: conv.customerName || conv.customerEmail || 'Unknown Customer',
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

interface ChatListClientProps {
  initialConversations: Helpdesk.Conversation[];
  workspaceId: string;
}

export default function ChatListClient({ initialConversations, workspaceId }: ChatListClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Chat' },
  ]);

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const handleNewConversation = useCallback((conversation: Partial<Helpdesk.Conversation>) => {
    if (conversation.channel !== 'chat') return;

    // Invalidate TanStack Query cache so the list refetches from DB
    queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });

    const newConversation: Helpdesk.Conversation = {
      id: conversation.id || '',
      conversationNumber: conversation.id || '',
      subject: conversation.subject || 'New conversation',
      status: conversation.status || 'active',
      priority: conversation.priority || 'normal',
      channel: conversation.channel || 'chat',
      createdAt: conversation.createdAt || new Date().toISOString(),
      isRead: false,
      preview: conversation.preview,
      lastMessageAt: conversation.lastMessageAt || conversation.createdAt,
      customerName: conversation.customerName,
      customerEmail: conversation.customerEmail,
    };

    setConversations(prev => [newConversation, ...prev]);
    const senderName = conversation.customerName || conversation.customerEmail || 'Customer';
    toast.success(ti.newChat, {
      description: ti.newConversationFrom.replace('{name}', senderName),
    });
    showBrowserNotification(ti.newLiveChat, {
      body: ti.newConversationFrom.replace('{name}', senderName),
      playSound: true,
    });
  }, [queryClient, ti.newChat, ti.newConversationFrom, ti.newLiveChat]);

  const handleAgentAssigned = useCallback((data: { conversationId: string; agentId: string; agentName: string }) => {
    queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });
    setConversations(prev => prev.map(conv =>
      conv.id === data.conversationId ? { ...conv, assigneeId: data.agentId, assigneeName: data.agentName } : conv
    ));
    toast.info(ti.conversationAssigned, { description: ti.conversationAssignedTo.replace('{name}', data.agentName) });
  }, [queryClient, ti]);

  useHelpdeskWebSocket({
    workspaceId,
    onNewConversation: handleNewConversation,
    onAgentAssigned: handleAgentAssigned,
  });

  const selectedConversationId = pathname.split('/').pop();

  const filteredConversations = conversations.filter(conv => {
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
        // Legacy PATCH /:id/read also zeroed unreadCount; app-api's generic
        // PATCH writes exactly what it is given, so send both.
        await client.patch(`/conversations/${item.id}`, { isRead: true, unreadCount: 0 });
      } catch { /* ignore */ }
      decrementHelpdeskBadge(queryClient);
    }
    router.push(`/welddesk/inbox/chat/${item.id}`);
  };

  const handleToggleStar = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: !conv.isStarred } : c));
    try {
      const client = await getClient();
      // Sends the TOGGLED value. The legacy call was doubly broken: it POSTed
      // to a PATCH-only route (404) and sent the pre-toggle value. Non-2xx now
      // throws, so the catch below is the only rollback path.
      await client.patch(`/conversations/${id}`, { isStarred: !conv.isStarred });
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
      getItemUrl={(item) => `/welddesk/inbox/chat/${item.id}`}
      onItemClick={handleItemClick}
      filterContent={filterContent}
      onToggleStar={handleToggleStar}
      contextMenuItems={getContextMenu}
      emptyMessage={ti.noLiveChatConversations}
    />
  );
}
