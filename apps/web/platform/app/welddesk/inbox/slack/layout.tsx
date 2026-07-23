
import React, { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import SlackListClient from './slack-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function SlackInboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { getToken } = useAuth();
  const [accessToken, setAccessToken] = useState<string>();

  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, channel: 'slack', excludeStatus: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  React.useEffect(() => {
    getToken().then(token => {
      if (token) setAccessToken(token);
    });
  }, [getToken]);

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/inbox/slack"
      list={
        <SlackListClient
          initialConversations={conversations}
          accessToken={accessToken}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
