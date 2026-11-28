/**
 * Time that is on an invoice (edition feature `books-time-billing`): the "Invoiced" chip that opens
 * the invoice, the reason an entry cannot be changed, and the row of an entry in a timesheet cell
 * with its edit and delete controls. An hour is invoiced once, so the server refuses to edit,
 * delete or approve an entry with an `invoiceId` (409); the timesheet says so before the click
 * instead of after it: the controls stay reachable, do nothing, and explain themselves.
 */

import { DollarSign, Loader2, Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Badge } from '@weldsuite/ui/components/badge';
import { LockedButton } from '@weldsuite/ui/components/locked-button';
import { RecordLink } from '@/components/object-panel/record-link';
import { formatHoursMinutes } from '@/lib/format-hours';
import { useI18n } from '@/lib/i18n/provider';

/** The "Invoiced" chip of an entry, linking to its invoice (the panel stacks over the timesheet). */
export function InvoicedChip({ invoiceId }: Readonly<{ invoiceId: string }>) {
  const { t } = useI18n();
  return <RecordLink type="invoice" id={invoiceId} label={t.weldbooksContactPage.flow.invoicedChip} tone="success" />;
}

/** Why an entry cannot be edited or deleted, or null while it can: invoiced first, then approved. */
export function entryLockReason(
  entry: Readonly<{ invoiceId?: string | null; status?: string }>,
  texts: Readonly<{ invoiced: string; approved: string }>,
): string | null {
  if (entry.invoiceId) return texts.invoiced;
  if (entry.status === 'approved') return texts.approved;
  return null;
}

/** The part of a time entry the row shows. */
export interface EntryRowData {
  id: string;
  duration: number;
  billable: boolean;
  status?: string;
  invoiceId?: string | null;
  description?: string;
  userName?: string;
}

/** One entry in a timesheet cell: its hours, state, text, and the edit and delete controls. */
export function TimesheetEntryRow<E extends EntryRowData>({
  entry,
  deleting,
  onEdit,
  onDelete,
}: Readonly<{ entry: E; deleting: boolean; onEdit: (entry: E) => void; onDelete: (entry: E) => void }>) {
  const st = useTranslations();
  const { t } = useI18n();
  const lockReason = entryLockReason(entry, {
    invoiced: t.weldbooksContactPage.flow.invoicedTip,
    approved: st('sweep.weldflow.timesheetPage.entryApprovedLocked'),
  });
  return (
    <div className="px-3 py-2 flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums">{formatHoursMinutes(entry.duration)}</span>
          {entry.billable && <DollarSign className="h-3 w-3 text-emerald-600" />}
          {entry.status && entry.status !== 'draft' && (
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              {entry.status}
            </Badge>
          )}
          {entry.invoiceId ? <InvoicedChip invoiceId={entry.invoiceId} /> : null}
        </div>
        {entry.description && (
          <div className="text-[12px] text-muted-foreground mt-0.5 break-words">{entry.description}</div>
        )}
        {entry.userName && (
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {st('sweep.weldflow.timesheetPage.byUser', { name: entry.userName })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <LockedButton
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={lockReason ? undefined : st('sweep.weldflow.edit')}
          aria-label={st('sweep.weldflow.edit')}
          lockedReason={lockReason}
          onClick={() => onEdit(entry)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </LockedButton>
        <LockedButton
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-red-600 hover:text-red-700"
          title={lockReason ? undefined : st('sweep.weldflow.delete')}
          aria-label={st('sweep.weldflow.delete')}
          lockedReason={lockReason}
          disabled={deleting}
          onClick={() => onDelete(entry)}
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </LockedButton>
      </div>
    </div>
  );
}
