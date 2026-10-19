/**
 * Credit notes tab of the invoice panel: the credit notes issued against the
 * invoice, which lower its balance once finalized. A row opens that credit
 * note in place, with a back arrow to this invoice.
 */

import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { InvoiceStatusChip } from './invoice-status';

export function InvoiceCreditNotesTab({
  invoice,
  onOpenInvoice,
}: Readonly<{ invoice: InvoiceWithTax; onOpenInvoice: (id: string) => void }>) {
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const notes = invoice.creditNotes ?? [];
  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {notes.map((note) => {
          const number = note.invoiceNumber ?? note.id;
          return (
            <TabListRow key={note.id} label={number} onOpen={() => onOpenInvoice(note.id)}>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium">{number}</span>
                <span className="flex-shrink-0">
                  <InvoiceStatusChip status={note.status} />
                </span>
              </div>
              <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums @max-[440px]:hidden">
                {formatDate(note.issueDate)}
              </span>
              <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
                -{formatMoney(note.total ?? '0', invoice.currency)}
              </span>
            </TabListRow>
          );
        })}
      </div>
    </TabListScope>
  );
}
