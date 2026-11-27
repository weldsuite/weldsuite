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

export function ConnectionsStrip({ lineId, amountLabel, currency }: Readonly<{ lineId: string; amountLabel: string; currency: string | null }>) {
  const { t } = useI18n();
  const tc = t.weldbooksConnected.processing.connections;
  const tp = t.accounting.bankTransactionPanel.connections;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { links } = useBankTransactionLinks(lineId);

  const chips: Array<{ key: string; node: ReactNode }> = [];
  if (links) {
    for (const allocation of links.allocations) {
      chips.push({
        key: `${allocation.documentType}:${allocation.documentId}`,
        node: (
          <RecordLink
            type={allocation.documentType}
            id={allocation.documentId}
            label={allocation.number ?? (allocation.documentType === 'invoice' ? tp.invoiceFallback : tp.billFallback)}
            secondary={formatMoney(allocation.amount, currency)}
          />
        ),
      });
    }
    if (links.payment && links.allocations.length === 0) {
      chips.push({
        key: `payment:${links.payment.id}`,
        node: (
          <RecordChip
            label={tc.payment}
            secondary={`${formatDate(links.payment.date)} · ${formatMoney(links.payment.amount, links.payment.currency ?? currency)}`}
          />
        ),
      });
    }
    for (const document of links.documents) {
      chips.push({ key: `doc:${document.id}`, node: <InboxDocumentChip id={document.id} fileName={document.fileName} /> });
    }
    if (links.category) {
      chips.push({
        key: `category:${links.category.accountId}`,
        node: (
          <RecordLink
            type="ledger_account"
            id={links.category.accountId}
            label={
              links.category.accountName
                ? [links.category.accountCode, links.category.accountName].filter(Boolean).join(' — ')
                : tp.accountFallback
            }
          />
        ),
      });
    }
    if (links.transfer?.counterpart) {
      chips.push({
        key: `transfer:${links.transfer.counterpart.id}`,
        node: (
          <RecordLink
            type="bank_transaction"
            id={links.transfer.counterpart.id}
            label={tc.transfer}
            secondary={formatMoney(links.transfer.counterpart.amount, currency)}
          />
        ),
      });
    }
    if (links.contact) {
      chips.push({
        key: `contact:${links.contact.id}`,
        node: <RecordLink type="weldbooks_contact" id={links.contact.id} label={links.contact.name ?? tp.contactFallback} />,
      });
    }
    if (links.journalEntry) {
      chips.push({
        key: `journal:${links.journalEntry.id}`,
        node: (
          <RecordLink
            type="journal_entry"
            id={links.journalEntry.id}
            label={links.journalEntry.entryNumber ?? t.accounting.statusLabels.journalEntry.fallback}
          />
        ),
      });
    }
  }

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
