
import React from 'react';
import AiActiveListClient from './ai-active-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useAiActiveConversations } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

export default function AiActiveLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data: result } = useAiActiveConversations({ page: 1, pageSize: 50 });
  const conversations: Helpdesk.Conversation[] = result?.data?.conversations || [];

  const isDetailSelected = useIsDetailSelected('/welddesk/ai-active');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
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
