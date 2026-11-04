
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import ConversationListClient from './conversation-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function AllInboxLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { getToken } = useAuth();
  const [accessToken, setAccessToken] = useState<string>();

  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, myConversations: true, excludeStatus: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  useEffect(() => {
    getToken().then(token => {
      if (token) setAccessToken(token);
    });
  }, [getToken]);

  const isDetailSelected = useIsDetailSelected('/welddesk/inbox/all');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
      list={
        <ConversationListClient
          initialConversations={conversations}
          accessToken={accessToken}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
