
import React from 'react';
import { useOrganization } from '@/lib/auth';
import ChatListClient from './chat-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function ChatInboxLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { organization } = useOrganization();

  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, channel: 'chat', myConversations: true, excludeStatus: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  const isDetailSelected = useIsDetailSelected('/welddesk/inbox/chat');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
      list={
        <ChatListClient
          initialConversations={conversations}
          workspaceId={organization?.id || ''}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
