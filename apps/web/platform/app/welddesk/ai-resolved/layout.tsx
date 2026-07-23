
import React from 'react';
import AiResolvedListClient from './ai-resolved-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useAiResolvedConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function AiResolvedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: result } = useAiResolvedConversations({ page: 1, pageSize: 50 });
  const conversations: Helpdesk.Conversation[] = result?.data?.conversations || [];

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/ai-resolved"
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
