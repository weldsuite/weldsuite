
import React from 'react';
import AiActiveListClient from './ai-active-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useAiActiveConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function AiActiveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: result } = useAiActiveConversations({ page: 1, pageSize: 50 });
  const conversations: Helpdesk.Conversation[] = result?.data?.conversations || [];

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/ai-active"
      list={
        <AiActiveListClient
          initialConversations={conversations}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
