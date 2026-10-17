import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { EmptyStateIllustration, type GroupConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { PageLoader } from '@/components/page-loader';
import { useCompleteDeadline, useReopenDeadline, useTaxCalendar } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { TaxDeadline } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { errorMessage, fill } from '../fixed-assets/text';
import { useDeadlineColumns, type DeadlineListRow } from './components/deadline-columns';
import { MarkDoneDialog } from './components/mark-done-dialog';
import { countStatuses, groupByMonth } from './deadline-status';

/** The tax due-date calendar of a US entity: income tax, estimated tax, 1099s, payroll and every sales tax return. */
export default function TaxCalendarPage() {
  const { t } = useI18n();
  const tc = t.weldbooksUs.assets.taxCalendar;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { code, isResolved, isError: jurisdictionError } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { today, dateLocale } = useWeldbooksFormat();

  const [year, setYear] = useState<number | undefined>(undefined);
  const calendar = useTaxCalendar(year, { enabled: isUs });
  const complete = useCompleteDeadline();
  const reopen = useReopenDeadline();
  const [marking, setMarking] = useState<TaxDeadline | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const data = calendar.data;
  const shownYear = year ?? data?.year ?? Number(today().slice(0, 4));
  const monthGroups = useMemo(() => groupByMonth(data?.items ?? []), [data?.items]);
  const counts = useMemo(() => (data ? countStatuses(data.items, data.today) : null), [data]);
  const monthName = useMemo(() => {
    const format = new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return (month: string) => {
      const name = format.format(new Date(`${month}-01T00:00:00Z`));
      return name.charAt(0).toUpperCase() + name.slice(1);
    };
  }, [dateLocale]);

  // The deadlines in month order, so each month's group reads in date order.
  const rows = useMemo<DeadlineListRow[]>(
    () => monthGroups.flatMap((group) => group.items.map((item) => ({ ...item, id: item.key }))),
    [monthGroups],
  );
  const groups = useMemo<GroupConfig<DeadlineListRow>[]>(
    () =>
      monthGroups.map((group, index) => ({
        id: group.month,
        label: monthName(group.month),
        sortOrder: index,
        filter: (row) => row.dueDate.startsWith(group.month),
      })),
    [monthGroups, monthName],
  );

  const canUpdate = can('taxes:update');

  const confirmDone = async (deadline: TaxDeadline, notes: string) => {
    setMarkError(null);
    setBusyKey(deadline.key);
    try {
      await complete.mutateAsync({ deadlineKey: deadline.key, dueDate: deadline.dueDate, ...(notes ? { notes } : {}) });
      setMarking(null);
      toast.success(tc.markedDone);
    } catch (err) {
      setMarkError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const undo = async (deadline: TaxDeadline) => {
    setBusyKey(deadline.key);
    try {
      await reopen.mutateAsync(deadline.key);
      toast.success(tc.reopened);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const columns = useDeadlineColumns({
    today: data?.today ?? today(),
    canUpdate,
    busyKey,
    onMarkDone: (item) => {
      setMarkError(null);
      setMarking(item);
    },
    onReopen: (item) => void undo(item),
  });

  if (!isResolved && !jurisdictionError) return <PageLoader fullScreen={false} />;

  if (!isUs || (data && !data.supported)) {
    return (
      <div className="space-y-2 p-4 sm:p-6">
        <h1 className="text-2xl font-semibold">{tc.title}</h1>
        <p className="text-sm text-muted-foreground">{common.usOnly}</p>
      </div>
    );
  }

  const yearNavigation = (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" className="h-8 w-8" aria-label={tc.previousYear} onClick={() => setYear(shownYear - 1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-14 text-center text-sm font-semibold tabular-nums" data-testid="calendar-year">
        {shownYear}
      </span>
      <Button variant="outline" size="icon" className="h-8 w-8" aria-label={tc.nextYear} onClick={() => setYear(shownYear + 1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  if (calendar.isError || (!data && !calendar.isLoading)) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        {yearNavigation}
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive" role="alert">
              {tc.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void calendar.refetch()}>
              {common.retry}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      {counts || data?.facts ? (
        <div className="space-y-2 p-4 pb-0 sm:px-6">
          {counts ? (
            <div className="flex flex-wrap gap-2" data-testid="calendar-counts">
              <Badge variant="destructive">{fill(tc.counts.overdue, { count: counts.overdue })}</Badge>
              <Badge variant="warning">{fill(tc.counts.dueSoon, { count: counts.dueSoon })}</Badge>
              <Badge variant="secondary">{fill(tc.counts.upcoming, { count: counts.upcoming })}</Badge>
              <Badge variant="success">{fill(tc.counts.done, { count: counts.done })}</Badge>
            </div>
          ) : null}
          {data?.facts ? <p className="text-xs text-muted-foreground">{tc.disclaimer}</p> : null}
        </div>
      ) : null}

      <div data-testid="tax-calendar-agenda">
        <WeldbooksEntityList<DeadlineListRow>
          items={rows}
          isLoading={calendar.isLoading}
          columns={columns}
          groups={groups}
          filters={[]}
          leftActionButtons={yearNavigation}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <CalendarDays className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
              </EmptyStateIllustration>
            ),
            title: fill(tc.emptyTitle, { year: shownYear }),
            description: fill(tc.emptyDescription, { year: shownYear }),
          }}
        />
      </div>

      {marking ? (
        <MarkDoneDialog
          deadline={marking}
          pending={complete.isPending}
          error={markError}
          onCancel={() => setMarking(null)}
          onConfirm={(notes) => void confirmDone(marking, notes)}
        />
      ) : null}
    </div>
  );
}
