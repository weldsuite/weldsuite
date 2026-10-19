import type { ReactNode } from 'react';
import { CalendarRange, CalendarX, Loader2, Lock, LockOpen } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowChip, RowDate, RowText, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import type { useFiscalCalendar } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { GenerateFiscalPeriodsResult, PlannedFiscalPeriod } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../fixed-assets/text';

/** A close / reopen the member still has to confirm. */
export type PendingStatusChange = { period: PlannedFiscalPeriod; action: 'close' | 'reopen' } | null;

type FiscalCalendarResult = ReturnType<typeof useFiscalCalendar>;
type FiscalCalendar = NonNullable<FiscalCalendarResult['data']>;

/** A planned period as a list row: its type and dates are its identity. */
type FiscalListRow = PlannedFiscalPeriod & { id: string };

/** Where the period stands: still to create, or its open / closed status once it exists. */
function PeriodStatusChip({ period }: Readonly<{ period: PlannedFiscalPeriod }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  if (!period.existingId) return <StatusChip tone="amber">{tf.toCreate}</StatusChip>;
  if (!period.existingStatus) return <StatusChip tone="green">{tf.exists}</StatusChip>;
  const closed = period.existingStatus === 'closed';
  return (
    <span data-testid={`fiscal-status-${period.name}`} className="inline-flex">
      <StatusChip tone={closed ? 'gray' : 'green'}>{closed ? tf.statuses.closed : tf.statuses.open}</StatusChip>
    </span>
  );
}

/** Close an open period, reopen a closed one; nothing for a period that does not exist yet. */
function PeriodStatusActions({
  period,
  onChangeStatus,
}: Readonly<{ period: PlannedFiscalPeriod; onChangeStatus: (change: PendingStatusChange) => void }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  return (
    <>
      {period.existingId && period.existingStatus === 'open' ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => onChangeStatus({ period, action: 'close' })}
          data-testid={`fiscal-close-${period.name}`}
        >
          <Lock className="h-4 w-4" aria-hidden />
          {tf.close}
        </Button>
      ) : null}
      {period.existingId && period.existingStatus === 'closed' ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => onChangeStatus({ period, action: 'reopen' })}
          data-testid={`fiscal-reopen-${period.name}`}
        >
          <LockOpen className="h-4 w-4" aria-hidden />
          {tf.reopen}
        </Button>
      ) : null}
    </>
  );
}

/** The columns of the periods list; the weeks column only for a 4-4-5 calendar, the actions only for members who can close periods. */
function useFiscalColumns({
  weekBased,
  canChangeStatus,
  onChangeStatus,
}: Readonly<{
  weekBased: boolean;
  canChangeStatus: boolean;
  onChangeStatus: (change: PendingStatusChange) => void;
}>): ColumnDef<FiscalListRow>[] {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const { formatDate } = useWeldbooksFormat();
  return [
    {
      id: 'period',
      header: tf.columns.period,
      width: 'min-w-[160px] flex-1 gap-2',
      render: (period) => <RowTitle>{period.name}</RowTitle>,
    },
    {
      id: 'type',
      header: tf.columns.type,
      width: 'w-[110px]',
      render: (period) => <RowText>{tf.types[period.type]}</RowText>,
    },
    {
      id: 'dates',
      header: tf.columns.dates,
      width: 'w-[260px]',
      render: (period) => (
        <RowDate>{`${formatDate(period.startDate)} – ${formatDate(period.endDate)}`}</RowDate>
      ),
    },
    ...(weekBased
      ? [
          {
            id: 'weeks',
            header: tf.columns.weeks,
            width: 'w-[80px]',
            render: (period: FiscalListRow) => <RowText className="tabular-nums">{period.weeks}</RowText>,
          },
        ]
      : []),
    {
      id: 'status',
      header: tf.columns.status,
      width: 'w-[190px] gap-1.5',
      render: (period) => (
        <>
          <PeriodStatusChip period={period} />
          {period.locked ? (
            <span title={tf.lockedHelp}>
              <RowChip tone="purple">{tf.statuses.locked}</RowChip>
            </span>
          ) : null}
        </>
      ),
    },
    ...(canChangeStatus
      ? [
          {
            id: 'actions',
            header: tf.columns.actions,
            width: 'w-[130px] justify-end',
            render: (period: FiscalListRow) => <PeriodStatusActions period={period} onChangeStatus={onChangeStatus} />,
          },
        ]
      : []),
  ];
}

/** The kind of calendar (months or 4-4-5 weeks), its length and the dates it spans. */
function FiscalSummary({ data, weekBased }: Readonly<{ data: FiscalCalendar; weekBased: boolean }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const { formatDate } = useWeldbooksFormat();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3" data-testid="fiscal-summary">
        <Badge variant={weekBased ? 'warning' : 'secondary'} className="gap-1.5">
          <CalendarRange aria-hidden />
          {weekBased ? tf.kinds.fifty_two_fifty_three : tf.kinds.month}
        </Badge>
        {data.weeks ? (
          <Badge variant={data.weeks === 53 ? 'warning' : 'outline'} data-testid="fiscal-weeks">
            {fill(tf.weeks, { weeks: data.weeks })}
          </Badge>
        ) : null}
        <span className="text-sm tabular-nums">
          {formatDate(data.startDate)} – {formatDate(data.endDate)}
        </span>
      </div>
      {weekBased ? (
        <p className="text-sm text-muted-foreground">{data.weeks === 53 ? tf.weekBasedNote53 : tf.weekBasedNote}</p>
      ) : null}
    </>
  );
}

/**
 * The calendar's periods as the standard list, with the year controls in its
 * toolbar; a spinner while loading, a retry (and the year controls) when it failed.
 */
export function FiscalCalendarBody({
  calendar,
  generated,
  canChangeStatus,
  onChangeStatus,
  leftActionButtons,
  actionButtons,
}: Readonly<{
  calendar: FiscalCalendarResult;
  generated: GenerateFiscalPeriodsResult | null;
  canChangeStatus: boolean;
  onChangeStatus: (change: PendingStatusChange) => void;
  /** Year choice and the optional quarter / whole-year periods. */
  leftActionButtons: ReactNode;
  /** The button that creates the missing periods. */
  actionButtons: ReactNode;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const common = t.weldbooksUs.assets.common;
  const data = calendar.data;
  const weekBased = data?.kind === 'fifty_two_fifty_three';
  const columns = useFiscalColumns({ weekBased, canChangeStatus, onChangeStatus });

  if (calendar.isError || (!data && !calendar.isLoading)) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">{leftActionButtons}</div>
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive" role="alert">
              {tf.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void calendar.refetch()}>
              {common.retry}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items: FiscalListRow[] = (data?.periods ?? []).map((period) => ({
    ...period,
    id: `${period.type}-${period.startDate}-${period.endDate}`,
  }));

  return (
    <div>
      {data ? (
        <div className="space-y-2 p-4 pb-0 sm:px-6">
          <FiscalSummary data={data} weekBased={weekBased} />
        </div>
      ) : null}

      <WeldbooksEntityList<FiscalListRow>
        items={items}
        isLoading={calendar.isLoading}
        columns={columns}
        leftActionButtons={leftActionButtons}
        actionButtons={actionButtons}
        filters={[]}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <CalendarX className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tf.title,
          description: tf.subtitle,
        }}
      />

      {generated ? (
        <p className="px-4 py-3 text-sm text-muted-foreground sm:px-6" data-testid="fiscal-generated">
          {fill(tf.generatedSummary, { created: generated.created.length, skipped: generated.skipped.length })}
        </p>
      ) : null}
    </div>
  );
}

/** Year choice and the optional quarter / whole-year periods: the left side of the list's toolbar. */
export function FiscalYearControls({
  fiscalYear,
  yearOptions,
  includeQuarters,
  includeYear,
  onYearChange,
  onIncludeQuartersChange,
  onIncludeYearChange,
}: Readonly<{
  fiscalYear: number;
  yearOptions: number[];
  includeQuarters: boolean;
  includeYear: boolean;
  onYearChange: (year: number) => void;
  onIncludeQuartersChange: (value: boolean) => void;
  onIncludeYearChange: (value: boolean) => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  return (
    <>
      <Select value={String(fiscalYear)} onValueChange={(value) => onYearChange(Number(value))}>
        <SelectTrigger id="fiscal-year" className="h-8 w-32" aria-label={tf.fiscalYear} title={tf.fiscalYearHelp}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {yearOptions.map((year) => (
            <SelectItem key={year} value={String(year)}>
              {year}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Checkbox id="fiscal-quarters" checked={includeQuarters} onCheckedChange={(checked) => onIncludeQuartersChange(checked === true)} />
        <Label htmlFor="fiscal-quarters" className="font-normal">
          {tf.includeQuarters}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="fiscal-whole-year" checked={includeYear} onCheckedChange={(checked) => onIncludeYearChange(checked === true)} />
        <Label htmlFor="fiscal-whole-year" className="font-normal">
          {tf.includeYear}
        </Label>
      </div>
    </>
  );
}

/** The button that creates the missing periods; the right side of the list's toolbar. */
export function FiscalGenerateButton({
  generating,
  missing,
  hasData,
  onGenerate,
}: Readonly<{ generating: boolean; missing: number; hasData: boolean; onGenerate: () => void }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  return (
    <Button size="sm" className="h-8" onClick={onGenerate} disabled={generating || missing === 0 || !hasData} data-testid="fiscal-generate">
      {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {missing === 0 && hasData ? tf.nothingToCreate : fill(tf.generate, { count: missing })}
    </Button>
  );
}

/** Confirms closing or reopening a period (open while a change is pending). */
export function StatusConfirmDialog({
  confirm,
  pending,
  onCancel,
  onConfirm,
}: Readonly<{
  confirm: PendingStatusChange;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const reopen = confirm?.action === 'reopen';
  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {fill(reopen ? tf.reopenTitle : tf.closeTitle, { period: confirm?.period.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{reopen ? tf.reopenDesc : tf.closeDesc}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tf.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            data-testid="fiscal-confirm"
          >
            {reopen ? tf.reopen : tf.close}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
