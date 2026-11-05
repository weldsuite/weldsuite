
import React from 'react';
import ArchivedListClient from './archived-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function ArchivedInboxLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, status: 'closed' });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  const isDetailSelected = useIsDetailSelected('/welddesk/inbox/archived');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
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
