
import React from 'react';
import ArchivedListClient from './archived-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function ArchivedInboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, status: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/inbox/archived"
      list={
        <ArchivedListClient
          initialConversations={conversations}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
