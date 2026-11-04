
import React from 'react';
import AiResolvedListClient from './ai-resolved-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useAiResolvedConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function AiResolvedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data: result } = useAiResolvedConversations({ page: 1, pageSize: 50 });
  const conversations: Helpdesk.Conversation[] = result?.data?.conversations || [];

  const isDetailSelected = useIsDetailSelected('/welddesk/ai-resolved');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
      list={
        <AiResolvedListClient
          initialConversations={conversations}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
