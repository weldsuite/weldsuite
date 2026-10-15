
import { useState, useEffect, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { toast } from 'sonner';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useHelpdeskWebSocket } from '@/hooks/helpdesk/use-helpdesk-websocket';
import { useI18n } from '@/lib/i18n/provider';
import { showOsNotification } from '@/lib/desktop-notifications';
import type { ConversationItem } from '@/components/shared/conversation-list';
import { InboxConversationList, WELDAGENT_ASSIGNEE, conversationToItem } from './inbox-conversation-list';

type InboxTexts = ReturnType<typeof useI18n>['t']['helpdesk']['inbox'];

interface ChannelConfig {
  label: (ti: InboxTexts) => string;
  /** Extra list-query parameters on top of `limit` and `channel`. */
  extraQuery: string;
  toItem: (conv: Helpdesk.Conversation, ti: InboxTexts) => ConversationItem;
  texts: (ti: InboxTexts) => { newTitle: string; newDescription: string; empty: string };
}

const CHANNELS: Record<'discord' | 'slack' | 'email', ChannelConfig> = {
  discord: {
    label: (ti) => ti.channels.discord,
    extraQuery: '&excludeStatus=closed',
    toItem: (conv, ti) => conversationToItem(conv, true, ti.unknownUser, ti.noSubject),
    texts: (ti) => ({ newTitle: ti.newDiscordMessage, newDescription: ti.newDiscordMessageDescription, empty: ti.noDiscordMessages }),
  },
  slack: {
    label: (ti) => ti.channels.slack,
    extraQuery: '',
    toItem: (conv, ti) => conversationToItem(conv, true, ti.unknownUser, ti.noSubject),
    texts: (ti) => ({ newTitle: ti.newSlackMessage, newDescription: ti.newSlackMessageDescription, empty: ti.noSlackMessages }),
  },
  email: {
    label: (ti) => ti.channels.email,
    extraQuery: '',
    toItem: (conv, ti) => conversationToItem(conv, false, ti.unknownSender, ti.noSubject),
    texts: (ti) => ({ newTitle: ti.newEmail, newDescription: ti.newEmailDescription, empty: ti.noEmailConversations }),
  },
};

export interface ChannelInboxClientProps {
  initialConversations: Helpdesk.Conversation[];
  accessToken?: string;
}

/** The Discord, Slack and e-mail inbox lists: one channel's open conversations, kept live over the helpdesk socket. */
export function ChannelInboxClient({
  channel,
  initialConversations,
  accessToken,
}: Readonly<ChannelInboxClientProps & { channel: keyof typeof CHANNELS }>) {
  const config = CHANNELS[channel];
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const texts = config.texts(ti);
  const toItem = useCallback((conv: Helpdesk.Conversation) => config.toItem(conv, ti), [config, ti]);
  const { getClient } = useAppApiClient();
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: ti.title, href: '/welddesk/inbox' },
    { label: config.label(ti) },
  ]);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const loadConversations = async () => {
    try {
      const client = await getClient();
      const result = await client.get<{ data: Helpdesk.Conversation[] }>(
        `/conversations?limit=50&channel=${channel}${config.extraQuery}`,
      );
      if (result.data) setConversations(result.data);
    } catch { /* ignore */ }
  };

  useHelpdeskWebSocket({
    isAgent: true,
    accessToken,
    onNewConversation: (newConversation) => {
      if (newConversation.channel !== channel) return;
      if (newConversation.assigneeName === WELDAGENT_ASSIGNEE) return;
      setConversations(prev => [newConversation as Helpdesk.Conversation, ...prev]);
      toast.success(texts.newTitle, { description: texts.newDescription });
      void showOsNotification({
        title: texts.newTitle,
        body: texts.newDescription,
        actionUrl: `/welddesk/inbox/${channel}/${newConversation.id}`,
      });
    },
    onAgentAssigned: (data) => {
      setConversations(prev => prev.map(conv =>
        conv.id === data.conversationId ? { ...conv, assigneeId: data.agentId, assigneeName: data.agentName } : conv
      ));
      if (data.agentName !== WELDAGENT_ASSIGNEE) {
        if (!conversations.some(c => c.id === data.conversationId)) void loadConversations();
        toast.info(ti.conversationAssigned, { description: ti.conversationAssignedTo.replace('{name}', data.agentName) });
      }
    },
  });

  return (
    <InboxConversationList
      conversations={conversations}
      setConversations={setConversations}
      toItem={toItem}
      itemUrl={(id) => `/welddesk/inbox/${channel}/${id}`}
      emptyMessage={texts.empty}
      hideAgentHandled
      updateMode="action-routes"
    />
  );
}
