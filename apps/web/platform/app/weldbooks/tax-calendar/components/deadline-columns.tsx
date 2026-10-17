import { Check, ExternalLink, Undo2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { ColumnDef } from '@/components/entity-list';
import { RowChip, RowDate, RowTitle, StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';
import type { TaxDeadline } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../../fixed-assets/text';
import { daysBetween, deadlineHref, deadlineStatus, type DeadlineStatus } from '../deadline-status';

/** A deadline as a list row: its key is its id. */
export type DeadlineListRow = TaxDeadline & { id: string };

const STATUS_TONE: Record<DeadlineStatus, ChipTone> = {
  done: 'green',
  overdue: 'red',
  dueSoon: 'amber',
  upcoming: 'blue',
  informational: 'gray',
};

interface DeadlineColumnsOptions {
  /** The entity's today, from the calendar. */
  today: string;
  canUpdate: boolean;
  /** The key of the deadline whose change is in flight. */
  busyKey: string | null;
  onMarkDone: (deadline: TaxDeadline) => void;
  onReopen: (deadline: TaxDeadline) => void;
}

/** The columns of the deadline list: what is due, when, its state, and what to do about it. */
export function useDeadlineColumns({
  today,
  canUpdate,
  busyKey,
  onMarkDone,
  onReopen,
}: Readonly<DeadlineColumnsOptions>): ColumnDef<DeadlineListRow>[] {
  const { t } = useI18n();
  const tc = t.weldbooksUs.assets.taxCalendar;
  const { formatDate, formatDateTime } = useWeldbooksFormat();

  return [
    {
      id: 'title',
      header: tc.columns.deadline,
      width: 'min-w-[240px] flex-1 gap-2',
      render: (deadline) => {
        const kindLabel = (tc.kinds as Record<string, string>)[deadline.kind] ?? deadline.kind;
        const details = [
          deadline.note,
          deadline.completionNotes,
          deadline.completionSource === 'return' ? tc.completedByReturn : null,
        ].filter((text): text is string => Boolean(text));
        return (
          <span className="flex min-w-0 items-center gap-2" title={details.join('\n') || undefined} data-testid={`deadline-${deadline.key}`}>
            <RowTitle chips={<RowChip tone="gray">{kindLabel}</RowChip>}>{deadline.title}</RowTitle>
          </span>
        );
      },
    },
    {
      id: 'dueDate',
      header: tc.dueDate,
      width: 'w-[130px]',
      render: (deadline) => {
        const hints = [
          deadline.nominalDate !== deadline.dueDate ? fill(tc.movedFrom, { date: formatDate(deadline.nominalDate) }) : null,
          deadline.extensionForm ? fill(tc.extension, { form: deadline.extensionForm }) : null,
        ].filter((text): text is string => Boolean(text));
        return (
          <span className="min-w-0" title={hints.join(' · ') || undefined}>
            <RowDate>{formatDate(deadline.dueDate)}</RowDate>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: tc.columns.status,
      width: 'w-[300px] gap-2',
      render: (deadline) => {
        const status = deadlineStatus(deadline, today);
        const days = daysBetween(today, deadline.dueDate);
        let when: string;
        if (status === 'done') {
          when = deadline.completedAt ? fill(tc.completedOn, { date: formatDateTime(deadline.completedAt) }) : tc.completed;
        } else if (days < 0) when = fill(days === -1 ? tc.overdueByOne : tc.overdueBy, { days: -days });
        else if (days === 0) when = tc.dueToday;
        else when = fill(days === 1 ? tc.dueInOne : tc.dueIn, { days });
        return (
          <>
            <span data-testid="deadline-status" data-status={status} className="inline-flex">
              <StatusChip tone={STATUS_TONE[status]}>{tc.status[status]}</StatusChip>
            </span>
            <span className="truncate text-xs text-muted-foreground">{when}</span>
          </>
        );
      },
    },
    {
      id: 'actions',
      header: tc.columns.actions,
      width: 'w-[260px] justify-end gap-2',
      render: (deadline) => {
        const href = deadlineHref(deadline);
        const hrefLabel = deadline.kind === 'sales_tax' ? tc.openSalesTax : tc.open1099;
        const busy = busyKey === deadline.key;
        return (
          <>
            {href ? (
              <Button variant="ghost" size="sm" className="h-7" asChild>
                <Link href={href}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  {hrefLabel}
                </Link>
              </Button>
            ) : null}
            {canUpdate && !deadline.completed ? (
              <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => onMarkDone(deadline)} data-testid="deadline-mark-done">
                <Check className="h-3.5 w-3.5" />
                {tc.markDone}
              </Button>
            ) : null}
            {canUpdate && deadline.completed && deadline.completionSource === 'manual' ? (
              <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => onReopen(deadline)} data-testid="deadline-undo">
                <Undo2 className="h-3.5 w-3.5" />
                {tc.undo}
              </Button>
            ) : null}
          </>
        );
      },
    },
  ];
}
