
import { useState, useEffect, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { helpdeskExtraKeys } from '@/hooks/queries/use-helpdesk-queries';
import { useHelpdeskWebSocket } from '@/hooks/helpdesk/use-helpdesk-websocket';
import { decrementHelpdeskBadge } from '@/hooks/use-sidebar-badges';
import { showBrowserNotification } from '@/lib/utils/notification-sound';
import { useI18n } from '@/lib/i18n/provider';
import { InboxConversationList, conversationToItem } from '../components/inbox-conversation-list';

const toItem = (conv: Helpdesk.Conversation) => conversationToItem(conv, true, 'Unknown Customer');

interface ChatListClientProps {
  initialConversations: Helpdesk.Conversation[];
  workspaceId: string;
}

export default function ChatListClient({ initialConversations, workspaceId }: Readonly<ChatListClientProps>) {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const queryClient = useQueryClient();
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Chat' },
  ]);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const handleNewConversation = useCallback((conversation: Partial<Helpdesk.Conversation>) => {
    if (conversation.channel !== 'chat') return;

    // Invalidate TanStack Query cache so the list refetches from DB
    void queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });

    const now = new Date();
    const newConversation: Helpdesk.Conversation = {
      id: conversation.id || '',
      conversationNumber: conversation.id || '',
      subject: conversation.subject || 'New conversation',
      status: conversation.status || 'active',
      priority: conversation.priority || 'medium',
      channel: conversation.channel || 'chat',
      createdAt: conversation.createdAt || now,
      updatedAt: conversation.updatedAt || now,
      isRead: false,
      isStarred: conversation.isStarred || false,
      isArchived: conversation.isArchived || false,
      hasAttachments: conversation.hasAttachments || false,
      messageCount: conversation.messageCount || 1,
      preview: conversation.preview || '',
      lastMessageAt: conversation.lastMessageAt || conversation.createdAt || now,
      customerName: conversation.customerName || 'Unknown Customer',
      customerEmail: conversation.customerEmail || '',
    };

    setConversations(prev => [newConversation, ...prev]);
    const senderName = conversation.customerName || conversation.customerEmail || 'Customer';
    toast.success(ti.newChat, {
      description: ti.newConversationFrom.replace('{name}', senderName),
    });
    void showBrowserNotification(ti.newLiveChat, {
      body: ti.newConversationFrom.replace('{name}', senderName),
      playSound: true,
      actionUrl: `/welddesk/inbox/chat/${newConversation.id}`,
    });
  }, [queryClient, ti.newChat, ti.newConversationFrom, ti.newLiveChat]);

  const handleAgentAssigned = useCallback((data: { conversationId: string; agentId: string; agentName: string }) => {
    void queryClient.invalidateQueries({ queryKey: helpdeskExtraKeys.conversations() });
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

  return (
    <InboxConversationList
      conversations={conversations}
      setConversations={setConversations}
      toItem={toItem}
      itemUrl={(id) => `/welddesk/inbox/chat/${id}`}
      emptyMessage={ti.noLiveChatConversations}
      hideAgentHandled={false}
      updateMode="generic"
      onMarkedRead={() => decrementHelpdeskBadge(queryClient)}
    />
  );
}
