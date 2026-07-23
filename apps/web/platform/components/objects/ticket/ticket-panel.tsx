import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { useTicket } from '@/hooks/queries/use-helpdesk-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  BadgeRow,
  SectionHeader,
  ProseBlock,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

export function TicketPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useTicket(id);
  const ticket = data?.data;

  const title =
    ticket?.subject ??
    (ticket?.ticketNumber
      ? t('sweep.entities.ticketNumberTitle', { number: ticket.ticketNumber })
      : t('sweep.entities.ticketFallbackTitle'));
  const subtitle = ticket?.ticketNumber
    ? `#${ticket.ticketNumber}${ticket.customerName ? ' · ' + ticket.customerName : ''}`
    : ticket?.customerName ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="ticket"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!ticket}
      title={ticket ? title : undefined}
      subtitle={subtitle ?? undefined}
      openHref={ticket ? `/welddesk/tickets/${ticket.id}` : undefined}
      statusBadges={ticket && (
        <>
          <Badge variant="outline" className="capitalize">{ticket.status}</Badge>
          <Badge variant="outline" className="capitalize">
            {t('sweep.entities.priorityLabel', { priority: ticket.priority })}
          </Badge>
          {ticket.source && <Badge variant="outline" className="capitalize">{ticket.source}</Badge>}
        </>
      )}
      fields={
        ticket
          ? [
              { label: t('sweep.entities.fieldCustomer'), value: ticket.customerName },
              { label: t('sweep.entities.fieldEmail'), value: ticket.customerEmail },
              { label: t('sweep.entities.fieldAssignee'), value: ticket.assigneeName },
              { label: t('sweep.entities.fieldChannel'), value: ticket.channel },
              { label: t('sweep.entities.fieldCreated'), value: formatPanelDate(ticket.createdAt) },
              { label: t('sweep.entities.fieldUpdated'), value: formatPanelDate(ticket.updatedAt) },
            ]
          : undefined
      }
      extras={
        ticket && (
          <>
            {ticket.description && (
              <>
                <SectionHeader>{t('sweep.entities.fieldDescription')}</SectionHeader>
                <ProseBlock>{ticket.description}</ProseBlock>
              </>
            )}
            {ticket.tags && ticket.tags.length > 0 && <BadgeRow values={ticket.tags} />}
            {ticket.linkedConversations && ticket.linkedConversations.length > 0 && (
              <>
                <SectionHeader>
                  {t('sweep.entities.linkedConversationsCount', {
                    count: ticket.linkedConversations.length,
                  })}
                </SectionHeader>
                <ul className="divide-y divide-border border-y border-border mx-4 mb-3">
                  {ticket.linkedConversations.map((conv) => (
                    <li key={conv.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="truncate">
                        {conv.subject || conv.customerName || t('sweep.entities.conversationFallback')}
                      </span>
                      {conv.status && (
                        <span className="text-xs text-muted-foreground capitalize">{conv.status}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )
      }
    />
  );
}
