
import { useState, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { toast } from 'sonner';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useHelpdeskWebSocket } from '@/hooks/helpdesk/use-helpdesk-websocket';
import { useI18n } from '@/lib/i18n/provider';
import { InboxConversationList, WELDAGENT_ASSIGNEE, conversationToItem } from '../components/inbox-conversation-list';

const toItem = (conv: Helpdesk.Conversation) => conversationToItem(conv, false, 'Unknown');

interface TeamListClientProps {
  teamId: string;
  teamName: string;
  initialConversations: Helpdesk.Conversation[];
  accessToken?: string;
}

export default function TeamListClient({ teamId, teamName, initialConversations, accessToken }: Readonly<TeamListClientProps>) {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Teams' },
    { label: teamName },
  ]);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  useHelpdeskWebSocket({
    isAgent: true,
    accessToken,
    onNewConversation: (newConversation) => {
      if (newConversation.departmentId !== teamId) return;
      if (newConversation.assigneeName === WELDAGENT_ASSIGNEE) return;
      setConversations(prev => [newConversation as Helpdesk.Conversation, ...prev]);
      toast.success(ti.newConversation, {
        description: ti.newConversationAssignedToTeam.replace('{name}', teamName),
      });
    },
    onAgentAssigned: (data) => {
      setConversations(prev => prev.map(conv =>
        conv.id === data.conversationId ? { ...conv, assigneeId: data.agentId, assigneeName: data.agentName } : conv
      ));
    },
  });

  return (
    <InboxConversationList
      conversations={conversations}
      setConversations={setConversations}
      toItem={toItem}
      itemUrl={(id) => `/welddesk/inbox/team/${teamId}/${id}`}
      emptyMessage={ti.noConversationsInTeam.replace('{name}', teamName)}
      hideAgentHandled
      updateMode="generic"
    />
  );
}
