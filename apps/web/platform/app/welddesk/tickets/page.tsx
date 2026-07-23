
import React from 'react';
import TicketListClient from './ticket-list-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { TicketsEmptyState } from './tickets-empty-state';

// ============================================================================
// Page
// ============================================================================

export default function TicketsPage() {
  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/tickets"
      list={<TicketListClient />}
    >
      <TicketsEmptyState />
    </ListDetailLayout>
  );
}
