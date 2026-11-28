/**
 * The Connections strip of the selected line: what it is linked to, as record
 * chips (documents, payment, journal entry, category, contact, the other side
 * of a transfer). Every chip stacks that record's panel.
 */

import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { InboxDocumentChip } from '@/components/accounting/inbox-document-chip';
import { RecordLink } from '@/components/object-panel/record-link';
import { useBankTransactionLinks } from '@/components/objects/bank-transaction/use-bank-transaction-links';
import type { BankLineLinks } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Whether the line is connected to anything yet. */
export function hasConnections(links: BankLineLinks): boolean {
  return Boolean(
    links.payment ||
      links.allocations.length > 0 ||
      links.journalEntry ||
      links.category ||
      links.deposit ||
      links.contact ||
      links.documents.length > 0 ||
      links.transfer?.counterpart,
  );
}

function Arrow() {
  return <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

type I18n = ReturnType<typeof useI18n>['t'];

interface Chip {
  key: string;
  node: ReactNode;
}

interface ChipContext {
  t: I18n;
  currency: string | null;
  formatMoney: ReturnType<typeof useWeldbooksFormat>['formatMoney'];
  formatDate: ReturnType<typeof useWeldbooksFormat>['formatDate'];
}

function allocationChips(links: BankLineLinks, { t, currency, formatMoney }: ChipContext): Chip[] {
  const tp = t.accounting.bankTransactionPanel.connections;
  return links.allocations.map((allocation) => {
    const fallback = allocation.documentType === 'invoice' ? tp.invoiceFallback : tp.billFallback;
    return {
      key: `${allocation.documentType}:${allocation.documentId}`,
      node: (
        <RecordLink
          type={allocation.documentType}
          id={allocation.documentId}
          label={allocation.number ?? fallback}
          secondary={formatMoney(allocation.amount, currency)}
        />
      ),
    };
  });
}

function paymentChips(links: BankLineLinks, { t, currency, formatMoney, formatDate }: ChipContext): Chip[] {
  const { payment } = links;
  if (!payment || links.allocations.length > 0) return [];
  const tc = t.weldbooksConnected.processing.connections;
  return [
    {
      key: `payment:${payment.id}`,
      node: (
        <RecordChip
          label={tc.payment}
          secondary={`${formatDate(payment.date)} · ${formatMoney(payment.amount, payment.currency ?? currency)}`}
        />
      ),
    },
  ];
}

function documentChips(links: BankLineLinks): Chip[] {
  return links.documents.map((document) => ({
    key: `doc:${document.id}`,
    node: <InboxDocumentChip id={document.id} fileName={document.fileName} />,
  }));
}

function categoryChips(links: BankLineLinks, { t }: ChipContext): Chip[] {
  const { category } = links;
  if (!category) return [];
  const tp = t.accounting.bankTransactionPanel.connections;
  const label = category.accountName
    ? [category.accountCode, category.accountName].filter(Boolean).join(' — ')
    : tp.accountFallback;
  return [{ key: `category:${category.accountId}`, node: <RecordLink type="ledger_account" id={category.accountId} label={label} /> }];
}

function transferChips(links: BankLineLinks, { t, currency, formatMoney }: ChipContext): Chip[] {
  const counterpart = links.transfer?.counterpart;
  if (!counterpart) return [];
  const tc = t.weldbooksConnected.processing.connections;
  return [
    {
      key: `transfer:${counterpart.id}`,
      node: (
        <RecordLink
          type="bank_transaction"
          id={counterpart.id}
          label={tc.transfer}
          secondary={formatMoney(counterpart.amount, currency)}
        />
      ),
    },
  ];
}

function contactChips(links: BankLineLinks, { t }: ChipContext): Chip[] {
  const { contact } = links;
  if (!contact) return [];
  const tp = t.accounting.bankTransactionPanel.connections;
  return [
    {
      key: `contact:${contact.id}`,
      node: <RecordLink type="weldbooks_contact" id={contact.id} label={contact.name ?? tp.contactFallback} />,
    },
  ];
}

function journalChips(links: BankLineLinks, { t }: ChipContext): Chip[] {
  const { journalEntry } = links;
  if (!journalEntry) return [];
  return [
    {
      key: `journal:${journalEntry.id}`,
      node: (
        <RecordLink
          type="journal_entry"
          id={journalEntry.id}
          label={journalEntry.entryNumber ?? t.accounting.statusLabels.journalEntry.fallback}
        />
      ),
    },
  ];
}

/** One chip per record the line is linked to, in the order they are shown. */
function connectionChips(links: BankLineLinks | undefined, ctx: ChipContext): Chip[] {
  if (!links) return [];
  return [
    ...allocationChips(links, ctx),
    ...paymentChips(links, ctx),
    ...documentChips(links),
    ...categoryChips(links, ctx),
    ...transferChips(links, ctx),
    ...contactChips(links, ctx),
    ...journalChips(links, ctx),
  ];
}

export function ConnectionsStrip({ lineId, amountLabel, currency }: Readonly<{ lineId: string; amountLabel: string; currency: string | null }>) {
  const { t } = useI18n();
  const tc = t.weldbooksConnected.processing.connections;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { links } = useBankTransactionLinks(lineId);
  const chips = connectionChips(links, { t, currency, formatMoney, formatDate });

  return (
    <section
      className="space-y-2.5 rounded-xl border px-5 py-4"
      aria-label={tc.title}
      data-testid="connections-strip"
    >
      <h3 className="text-[13px] font-semibold">{tc.title}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-h-6 items-center rounded-md bg-muted px-2 py-0.5 text-[13px] font-medium tabular-nums">
          {tc.line.replace('{amount}', amountLabel)}
        </span>
        {chips.map((chip) => (
          <span key={chip.key} className="inline-flex items-center gap-2">
            <Arrow />
            {chip.node}
          </span>
        ))}
        {chips.length === 0 ? <span className="text-[13px] text-muted-foreground">{tc.none}</span> : null}
      </div>
    </section>
  );
}
