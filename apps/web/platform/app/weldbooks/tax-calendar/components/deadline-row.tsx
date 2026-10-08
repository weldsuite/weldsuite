import { Check, ExternalLink, Undo2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type { TaxDeadline } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../../fixed-assets/text';
import { daysBetween, deadlineHref, deadlineStatus, type DeadlineStatus } from '../deadline-status';

const STATUS_VARIANT: Record<DeadlineStatus, 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  done: 'success',
  overdue: 'destructive',
  dueSoon: 'warning',
  upcoming: 'secondary',
  informational: 'outline',
};

interface DeadlineRowProps {
  deadline: TaxDeadline;
  /** The entity's today, from the calendar. */
  today: string;
  canUpdate: boolean;
  busy: boolean;
  onMarkDone: (deadline: TaxDeadline) => void;
  onReopen: (deadline: TaxDeadline) => void;
}

/** One deadline: what is due, when, its state, and what to do about it. */
export function DeadlineRow({ deadline, today, canUpdate, busy, onMarkDone, onReopen }: Readonly<DeadlineRowProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.assets.taxCalendar;
  const { formatDate, formatDateTime } = useWeldbooksFormat();
  const status = deadlineStatus(deadline, today);
  const days = daysBetween(today, deadline.dueDate);
  const href = deadlineHref(deadline);
  const hrefLabel = deadline.kind === 'sales_tax' ? tc.openSalesTax : tc.open1099;
  const kindLabel = (tc.kinds as Record<string, string>)[deadline.kind] ?? deadline.kind;

  let when: string;
  if (status === 'done') when = deadline.completedAt ? fill(tc.completedOn, { date: formatDateTime(deadline.completedAt) }) : tc.completed;
  else if (days < 0) when = fill(days === -1 ? tc.overdueByOne : tc.overdueBy, { days: -days });
  else if (days === 0) when = tc.dueToday;
  else when = fill(days === 1 ? tc.dueInOne : tc.dueIn, { days });

  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between" data-testid={`deadline-${deadline.key}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{deadline.title}</p>
          <Badge variant="outline">{kindLabel}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {tc.dueDate}: <span className="font-medium text-foreground">{formatDate(deadline.dueDate)}</span>
          {deadline.nominalDate !== deadline.dueDate ? ` · ${fill(tc.movedFrom, { date: formatDate(deadline.nominalDate) })}` : ''}
          {deadline.extensionForm ? ` · ${fill(tc.extension, { form: deadline.extensionForm })}` : ''}
        </p>
        {deadline.note ? <p className="text-xs text-muted-foreground">{deadline.note}</p> : null}
        {deadline.completionNotes ? <p className="text-xs text-muted-foreground">{deadline.completionNotes}</p> : null}
        {deadline.completionSource === 'return' ? <p className="text-xs text-muted-foreground">{tc.completedByReturn}</p> : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <div className="flex flex-col items-start gap-0.5 sm:items-end">
          <Badge variant={STATUS_VARIANT[status]} data-testid="deadline-status" data-status={status}>
            {tc.status[status]}
          </Badge>
          <span className="text-xs text-muted-foreground">{when}</span>
        </div>
        {href ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={href}>
              <ExternalLink className="h-3.5 w-3.5" />
              {hrefLabel}
            </Link>
          </Button>
        ) : null}
        {canUpdate && !deadline.completed ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onMarkDone(deadline)} data-testid="deadline-mark-done">
            <Check className="h-3.5 w-3.5" />
            {tc.markDone}
          </Button>
        ) : null}
        {canUpdate && deadline.completed && deadline.completionSource === 'manual' ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onReopen(deadline)} data-testid="deadline-undo">
            <Undo2 className="h-3.5 w-3.5" />
            {tc.undo}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
