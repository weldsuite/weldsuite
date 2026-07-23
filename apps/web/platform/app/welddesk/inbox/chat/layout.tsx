
import React from 'react';
import { useOrganization } from '@clerk/clerk-react';
import ChatListClient from './chat-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function ChatInboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { organization } = useOrganization();

  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, channel: 'chat', myConversations: true, excludeStatus: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/inbox/chat"
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
