/**
 * The Finance tab of a WeldCRM company or person (edition feature `books-contact-page`): what the
 * WeldBooks contact behind the record owes and is owed, its recent invoices and open quotes, and a
 * chip that opens the contact in WeldBooks. A record with no WeldBooks contact gets a calm empty
 * state and "Add to WeldBooks", which creates the contact through the same create flow the
 * Contacts page uses, linked to this record.
 */

import { useMemo } from 'react';
import { ScrollText, Wallet } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useObjectPanel } from '@/components/object-panel';
import { RecordLink } from '@/components/object-panel/record-link';
import { useCreateContact } from '@/app/weldbooks/customers/components/use-create-contact';
import type { ContactPayload } from '@/app/weldbooks/customers/components/contact-form';
import { useContactByCrm, useContactInvoicesPaged } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import { isQuotesAvailable, useInfiniteQuotes } from '@/hooks/queries/use-weldbooks-sales-queries';
import { useI18n } from '@/lib/i18n/provider';
import { plural } from '@/lib/i18n/plural';
import { countOf, describeSums, nonZero } from '@/lib/weldbooks/contact-page';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { cn } from '@/lib/utils';

/** The CRM record the tab is for, with what a new WeldBooks contact starts from. */
export interface CrmFinanceTarget {
  kind: 'company' | 'person';
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}

const RECENT_INVOICES = 5;

function Figure({ label, value, hint, alert }: Readonly<{ label: string; value: string; hint?: string; alert?: boolean }>) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('truncate text-lg font-semibold tabular-nums', alert && 'text-destructive')}>{value}</dd>
      {hint ? <dd className="truncate text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

type FinanceInvoice = NonNullable<ReturnType<typeof useContactInvoicesPaged>['data']>['rows'][number];
type FinanceQuote = NonNullable<ReturnType<typeof useInfiniteQuotes>['data']>['rows'][number];

function invoiceTone(status: string): 'danger' | 'success' | 'neutral' {
  if (status === 'overdue') return 'danger';
  if (status === 'paid') return 'success';
  return 'neutral';
}

function RecentInvoices({ loading, invoices }: Readonly<{ loading: boolean; invoices: FinanceInvoice[] }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const statusLabels = t.accounting.statusLabels.invoice as Record<string, string>;
  if (loading) return <InlineSpinner className="py-3" />;
  if (invoices.length === 0) return <p className="text-sm text-muted-foreground">{copy.finance.noInvoices}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {invoices.map((invoice) => (
        <li key={invoice.id} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
            <RecordLink
              type="invoice"
              id={invoice.id}
              label={invoice.invoiceNumber ?? copy.overview.noNumber}
              tone={invoiceTone(invoice.status)}
              statusLabel={statusLabels[invoice.status]}
            />
            <span className="text-xs text-muted-foreground">{formatDate(invoice.issueDate)}</span>
          </div>
          <span className="flex-shrink-0 text-sm font-medium tabular-nums">{formatMoney(invoice.total ?? '0', invoice.currency)}</span>
        </li>
      ))}
    </ul>
  );
}

function OpenQuotes({ loading, quotes }: Readonly<{ loading: boolean; quotes: FinanceQuote[] }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage;
  const { formatMoney } = useWeldbooksFormat();
  if (loading) return <InlineSpinner className="py-3" />;
  if (quotes.length === 0) return <p className="text-sm text-muted-foreground">{copy.finance.noOpenQuotes}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {quotes.map((quote) => (
        <li key={quote.id} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
          <div className="min-w-0 flex-1">
            <RecordLink type="quote" id={quote.id} icon={ScrollText} label={quote.quoteNumber ?? quote.name ?? copy.overview.noNumber} />
          </div>
          <span className="flex-shrink-0 text-sm font-medium tabular-nums">{formatMoney(quote.total ?? '0', quote.currency)}</span>
        </li>
      ))}
    </ul>
  );
}

function FinanceOfContact({ contactId, summary }: Readonly<{ contactId: string; summary: NonNullable<ReturnType<typeof useContactByCrm>['data']>['summary'] }>) {
  const { t, language } = useI18n();
  const copy = t.weldbooksContactPage;
  const tiles = copy.tiles;
  const { formatMoney } = useWeldbooksFormat();
  const invoices = useContactInvoicesPaged(contactId);
  const quotes = useInfiniteQuotes({ contactId, status: 'sent' }, { enabled: isQuotesAvailable() });
  const recent = useMemo(() => (invoices.data?.rows ?? []).slice(0, RECENT_INVOICES), [invoices.data?.rows]);
  const sentQuotes = quotes.data?.rows ?? [];

  const toReceive = describeSums(summary.toReceive, formatMoney);
  const overdue = describeSums(summary.overdue, formatMoney);
  const toPay = describeSums(summary.toPay, formatMoney);
  const extra = (others: string[]) => (others.length > 0 ? tiles.moreCurrencies.replace('{amounts}', others.join(', ')) : undefined);
  const receiveCount = countOf(summary.toReceive);

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.finance.figures}</h3>
        <RecordLink type="weldbooks_contact" id={contactId} label={copy.finance.openInWeldbooks} />
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <Figure
          label={tiles.toReceive}
          value={toReceive.primary}
          hint={extra(toReceive.others) ?? (receiveCount > 0 ? plural(receiveCount, tiles.invoices, language) : undefined)}
        />
        <Figure label={tiles.overdue} value={overdue.primary} hint={extra(overdue.others)} alert={!overdue.isEmpty} />
        <Figure label={tiles.toPay} value={toPay.primary} hint={extra(toPay.others)} />
        <Figure
          label={copy.finance.openQuotes}
          value={String(summary.openQuotes.count)}
          hint={
            nonZero(summary.openQuotes.amount)
              .map((sum) => formatMoney(sum.amount, sum.currency))
              .join(', ') || undefined
          }
        />
      </dl>

      <section aria-labelledby="crm-finance-invoices" className="space-y-1">
        <h3 id="crm-finance-invoices" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {copy.finance.recentInvoices}
        </h3>
        <RecentInvoices loading={invoices.isLoading} invoices={recent} />
      </section>

      {isQuotesAvailable() ? (
        <section aria-labelledby="crm-finance-quotes" className="space-y-1">
          <h3 id="crm-finance-quotes" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {copy.finance.openQuotes}
          </h3>
          <OpenQuotes loading={quotes.isLoading} quotes={sentQuotes.slice(0, RECENT_INVOICES)} />
        </section>
      ) : null}
    </div>
  );
}

/** What a new contact is made of: the record's own name and details, as a customer. */
export function contactPayloadOf(target: CrmFinanceTarget): ContactPayload {
  const base = {
    role: 'customer' as const,
    name: target.name,
    ...(target.email ? { email: target.email } : {}),
    ...(target.phone ? { phone: target.phone } : {}),
  };
  if (target.kind === 'company') {
    return { ...base, kind: 'company', companyId: target.id, companyName: target.name };
  }
  return {
    ...base,
    kind: 'person',
    personId: target.id,
    ...(target.firstName ? { firstName: target.firstName } : {}),
    ...(target.lastName ? { lastName: target.lastName } : {}),
  };
}

export function CrmFinanceTab({ target }: Readonly<{ target: CrmFinanceTarget }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.finance;
  const permissions = usePermissionsMaybe();
  const canRead = permissions?.can('invoices:read') ?? false;
  const canCreate = permissions?.can('invoices:create') ?? false;
  const { open: openPanel } = useObjectPanel();
  const lookup = useMemo(() => (target.kind === 'company' ? { companyId: target.id } : { personId: target.id }), [target.kind, target.id]);
  const query = useContactByCrm(lookup, { enabled: canRead });
  const create = useCreateContact({
    onCreated: (contactId) => {
      if (contactId) openPanel({ type: 'weldbooks_contact', id: contactId, stack: true });
    },
    onOpenExisting: (contactId) => openPanel({ type: 'weldbooks_contact', id: contactId, stack: true }),
  });

  if (!canRead) return <p className="p-6 text-center text-sm text-muted-foreground">{copy.noPermission}</p>;
  if (query.isLoading) return <InlineSpinner />;
  if (query.isError) {
    return (
      <div className="p-4">
        <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const found = query.data;
  if (!found) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Wallet}
          title={copy.noContactTitle}
          description={copy.noContactDescription}
          action={
            canCreate ? (
              <Button type="button" size="sm" disabled={create.isPending} onClick={() => void create.submit(contactPayloadOf(target))}>
                {create.isPending ? copy.adding : copy.addToWeldbooks}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  return <FinanceOfContact contactId={found.contact.id} summary={found.summary} />;
}
