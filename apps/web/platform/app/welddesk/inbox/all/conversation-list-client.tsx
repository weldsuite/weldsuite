
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useAuth, useUser } from '@clerk/clerk-react';
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
import { showBrowserNotification, requestNotificationPermission } from '@/lib/utils/notification-sound';
import { useI18n } from '@/lib/i18n/provider';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@weldsuite/ui/components/context-menu';
import { Star, Archive, Trash2 } from 'lucide-react';

type FilterType = 'all' | 'unread' | 'starred' | 'urgent' | 'active';

function conversationToItem(conv: Helpdesk.Conversation): ConversationItem {
  return {
    id: conv.id,
    name: conv.customerName || conv.customerEmail || 'Unknown Customer',
    email: conv.customerEmail,
    avatarUrl: conv.customerAvatarUrl || conv.customerAvatar || undefined,
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

interface ConversationListClientProps {
  initialConversations: Helpdesk.Conversation[];
  accessToken?: string;
}

export default function ConversationListClient({ initialConversations, accessToken }: ConversationListClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const { user } = useUser();
  const userName = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Agent';
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Conversations' },
  ]);

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  const { isConnected } = useHelpdeskWebSocket({
    isAgent: true,
    accessToken,
    onNewConversation: async (newConversation) => {
      // Invalidate TanStack Query cache so the list refetches from DB
      queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });

      if (newConversation.id) {
        try {
          const client = await getClient();
          // app-api returns { data: conversation }. The legacy code unwrapped
          // twice (response.data -> result.data) and gated on a `success` flag
          // the client never surfaced, so this block could never run.
          const response = await client.get<{ data: Helpdesk.Conversation }>(
            `/conversations/${newConversation.id}`,
          );
          const conversation = response.data;
          if (conversation) {
            if (conversation.assigneeId === 'weldagent-system') return;
            if (conversation.assigneeId && conversation.assigneeId !== userId) return;
            setConversations(prev => {
              if (prev.some(c => c.id === conversation.id)) return prev;
              return [conversation, ...prev];
            });
            toast.success(ti.newConversationStarted, {
              description: ti.newConversationVia.replace('{channel}', conversation.channel || 'widget'),
            });
            showBrowserNotification('New Helpdesk Conversation', {
              body: `A new conversation has been started via ${conversation.channel || 'widget'}`,
              playSound: true,
            });
          }
        } catch (error) {
          console.error('Failed to fetch new conversation:', error);
        }
      }
    },
    onAgentAssigned: async (data) => {
      queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });
      try {
        const client = await getClient();
        // See the note in onNewConversation: app-api returns { data: conversation }.
        const response = await client.get<{ data: Helpdesk.Conversation }>(
          `/conversations/${data.conversationId}`,
        );
        const conversation = response.data;
        if (conversation) {
          if (conversation.assigneeId === 'weldagent-system') {
            setConversations(prev => prev.filter(c => c.id !== data.conversationId));
            return;
          }
          // Remove conversations assigned to other agents
          if (conversation.assigneeId && conversation.assigneeId !== userId) {
            setConversations(prev => prev.filter(c => c.id !== data.conversationId));
            return;
          }
          setConversations(prev => {
            const exists = prev.some(c => c.id === data.conversationId);
            if (exists) {
              return prev.map(conv =>
                conv.id === data.conversationId ? conversation : conv
              );
            } else {
              return [conversation, ...prev];
            }
          });
          toast.info(ti.conversationAssigned, {
            description: ti.conversationAssignedTo.replace('{name}', conversation.assigneeName || data.agentName),
          });
        }
      } catch (error) {
        console.error('Failed to fetch assigned conversation:', error);
      }
    },
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

  const handleItemClick = (item: ConversationItem) => {
    const conversation = conversations.find(c => c.id === item.id);
    if (conversation && !conversation.isRead) {
      setConversations(prev => prev.map(c =>
        c.id === item.id ? { ...c, isRead: true } : c
      ));
      // Legacy PATCH /:id/read also zeroed unreadCount; app-api's generic PATCH
      // writes exactly what it is given, so send both.
      getClient().then(client => client.patch(`/conversations/${item.id}`, { isRead: true, unreadCount: 0 })).catch(() => {});
      decrementHelpdeskBadge(queryClient);
    }
    router.push(`/welddesk/inbox/all/${item.id}`);
  };

  const handleToggleStar = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;

    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, isStarred: !conv.isStarred } : c
    ));

    try {
      const client = await getClient();
      // Sends the TOGGLED value. The legacy call was doubly broken: it POSTed
      // to a PATCH-only route (404) and sent the pre-toggle value.
      await client.patch(`/conversations/${id}`, { isStarred: !conv.isStarred });
    } catch (error) {
      setConversations(prev => prev.map(c =>
        c.id === id ? { ...c, isStarred: conv.isStarred } : c
      ));
      toast.error(ti.failedToUpdateStarStatus);
    }
  };

  const getContextMenu = (item: ConversationItem) => {
    const conv = conversations.find(c => c.id === item.id);
    if (!conv) return null;
    return (
      <>
        <ContextMenuItem onClick={() => handleToggleStar(item.id)}>
          <Star className={cn('h-4 w-4 mr-0.5', conv.isStarred && 'text-yellow-500 fill-yellow-500')} />
          {conv.isStarred ? ti.unstar : ti.star}
        </ContextMenuItem>
      </>
    );
  };

  const filterContent = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-8 text-sm px-3 shadow-none gap-1.5',
            activeFilter !== 'all' ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          Filter
          {activeFilter !== 'all' && (
            <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">
              1
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">{ti.status}</p>
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: 'all' as FilterType, label: ti.all },
            { value: 'unread' as FilterType, label: ti.filters.unread },
            { value: 'starred' as FilterType, label: ti.filters.starred },
            { value: 'urgent' as FilterType, label: ti.filters.urgent },
            { value: 'active' as FilterType, label: ti.filters.active },
          ].map(({ value, label }) => (
            <Toggle
              key={value}
              size="sm"
              variant="outline"
              pressed={activeFilter === value}
              onPressedChange={() => setActiveFilter(value)}
              className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
            >
              {label}
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
      getItemUrl={(item) => `/welddesk/inbox/all/${item.id}`}
      onItemClick={handleItemClick}
      filterContent={filterContent}
      onToggleStar={handleToggleStar}
      contextMenuItems={getContextMenu}
      emptyMessage={ti.noConversationsFound}
    />
  );
}
