
import React from 'react';
import TicketListClient from './ticket-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { TicketsEmptyState } from './tickets-empty-state';

// ============================================================================
// Page
// ============================================================================

export default function TicketsPage() {
  const isDetailSelected = useIsDetailSelected('/welddesk/tickets');

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
      list={<TicketListClient />}
    >
      <TicketsEmptyState />
    </ListDetailLayout>
  );
}
