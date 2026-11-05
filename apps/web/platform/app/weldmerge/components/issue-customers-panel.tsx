import { useMemo } from 'react';
import { Building2 } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import type { MergeIssueDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useObjectPanel } from '@/components/object-panel';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { weldmergeKeys } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { collectIssueCustomers } from '../lib/across';
import { fill } from '../lib/format';

/** The company a desk ticket belongs to: its CRM counterparty. */
interface TicketCompanyRow {
  counterpartyId?: string | null;
  customerCompany?: string | null;
}

/**
 * The companies an issue is for: linked to it directly or through the tickets
 * linked to it. Each opens its company panel.
 */
export function IssueCustomersPanel({ issue }: Readonly<{ issue: Pick<MergeIssueDetailDto, 'recordLinks'> }>) {
  const { t } = useI18n();
  const tc = t.weldmerge.across.issue.customers;
  const panel = useObjectPanel();
  const { getClient } = useAppApiClient();

  const ticketLinks = useMemo(() => issue.recordLinks.filter((link) => link.recordType === 'desk_ticket'), [issue.recordLinks]);
  const tickets = useQueries({
    queries: ticketLinks.map((link) => ({
      queryKey: [...weldmergeKeys.all, 'ticket-company', link.recordId],
      queryFn: async () => {
        const client = await getClient();
        return client.get<{ data: TicketCompanyRow }>(`/tickets/${link.recordId}`);
      },
      staleTime: 60_000,
    })),
  });

  const ticketCompanies = useMemo(
    () => new Map(ticketLinks.map((link, index) => [link.recordId, tickets[index]?.data?.data?.counterpartyId ?? null] as const)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tickets` is a new array each render; its data identity is what matters
    [ticketLinks, ...tickets.map((query) => query.data)],
  );
  const companyNames = useMemo(() => {
    const names = new Map<string, string>();
    tickets.forEach((query) => {
      const row = query.data?.data;
      if (row?.counterpartyId && row.customerCompany) names.set(row.counterpartyId, row.customerCompany);
    });
    return names;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see ticketCompanies
  }, [...tickets.map((query) => query.data)]);
  const customers = useMemo(() => collectIssueCustomers(issue.recordLinks, ticketCompanies), [issue.recordLinks, ticketCompanies]);

  if (customers.length === 0) return <p className="text-sm text-muted-foreground">{tc.empty}</p>;

  return (
    <ul className="space-y-1">
      {customers.map((customer) => (
        <li key={customer.companyId}>
          <button
            type="button"
            onClick={() => panel.open({ type: 'company', id: customer.companyId })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            <Building2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{customer.title ?? companyNames.get(customer.companyId) ?? customer.companyId}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {customer.viaTicket
                ? fill(tc.viaTicket, { ticket: customer.viaTicket.title ?? customer.viaTicket.id })
                : tc.direct}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
