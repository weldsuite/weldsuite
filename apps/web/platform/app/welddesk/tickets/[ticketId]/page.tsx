
import React from 'react';
import { useParams } from '@/lib/router';
import TicketListClient from '../ticket-list-client';
import TicketDetailClient from './ticket-detail-client';
import { ListDetailLayout } from '@/components/list-detail-layout';
import { useTicket } from '@/hooks/queries/use-helpdesk-queries';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

// ============================================================================
// Page
// ============================================================================

export default function TicketPage() {
  const { t } = useI18n();
  const params = useParams();
  const ticketId = params.ticketId as string;

  const { data: ticketData, isLoading } = useTicket(ticketId);
  const ticket = ticketData?.data;

  return (
    <ListDetailLayout
      listWidth={420}
      basePath="/welddesk/tickets"
      list={<TicketListClient />}
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t.helpdesk.inbox.loading}</span>
        </div>
      ) : !ticket ? (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">{t.helpdesk.ticketDetailPage.ticketNotFound}</p>
        </div>
      ) : (
        <TicketDetailClient key={ticketId} ticket={ticket} />
      )}
    </ListDetailLayout>
  );
}
