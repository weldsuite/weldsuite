import { CalendarRange, Loader2, Lock, LockOpen } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import type { useFiscalCalendar } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { GenerateFiscalPeriodsResult, PlannedFiscalPeriod } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../fixed-assets/text';

/** A close / reopen the member still has to confirm. */
export type PendingStatusChange = { period: PlannedFiscalPeriod; action: 'close' | 'reopen' } | null;

type FiscalCalendarResult = ReturnType<typeof useFiscalCalendar>;
type FiscalCalendar = NonNullable<FiscalCalendarResult['data']>;

/** Where the period stands: still to create, or its open / closed status once it exists. */
function PeriodStatusBadge({ period }: Readonly<{ period: PlannedFiscalPeriod }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  if (!period.existingId) return <Badge variant="outline">{tf.toCreate}</Badge>;
  if (!period.existingStatus) return <Badge variant="success">{tf.exists}</Badge>;
  const closed = period.existingStatus === 'closed';
  return (
    <Badge variant={closed ? 'secondary' : 'success'} data-testid={`fiscal-status-${period.name}`}>
      {closed ? tf.statuses.closed : tf.statuses.open}
    </Badge>
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

function PeriodRow({
  period,
  weekBased,
  canChangeStatus,
  onChangeStatus,
}: Readonly<{
  period: PlannedFiscalPeriod;
  weekBased: boolean;
  canChangeStatus: boolean;
  onChangeStatus: (change: PendingStatusChange) => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const { formatDate } = useWeldbooksFormat();
  return (
    <TableRow data-testid={`fiscal-period-${period.name}`}>
      <TableCell className="whitespace-nowrap font-medium">{period.name}</TableCell>
      <TableCell>{tf.types[period.type]}</TableCell>
      <TableCell className="whitespace-nowrap">
        {formatDate(period.startDate)} – {formatDate(period.endDate)}
      </TableCell>
      {weekBased ? (
        <TableCell className="text-right tabular-nums">
          {period.weeks === null ? '' : period.weeks}
        </TableCell>
      ) : null}
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <PeriodStatusBadge period={period} />
          {period.locked ? (
            <Badge variant="warning" title={tf.lockedHelp}>
              {tf.statuses.locked}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      {canChangeStatus ? (
        <TableCell className="text-right">
          <PeriodStatusActions period={period} onChangeStatus={onChangeStatus} />
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function PeriodsTable({
  data,
  weekBased,
  canChangeStatus,
  onChangeStatus,
}: Readonly<{
  data: FiscalCalendar;
  weekBased: boolean;
  canChangeStatus: boolean;
  onChangeStatus: (change: PendingStatusChange) => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tf.columns.period}</TableHead>
            <TableHead>{tf.columns.type}</TableHead>
            <TableHead>{tf.columns.dates}</TableHead>
            {weekBased ? <TableHead className="text-right">{tf.columns.weeks}</TableHead> : null}
            <TableHead>{tf.columns.status}</TableHead>
            {canChangeStatus ? <TableHead className="text-right">{tf.columns.actions}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.periods.map((period) => (
            <PeriodRow
              key={`${period.type}-${period.startDate}-${period.endDate}`}
              period={period}
              weekBased={weekBased}
              canChangeStatus={canChangeStatus}
              onChangeStatus={onChangeStatus}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
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
        <span className="text-sm text-muted-foreground">
          {formatDate(data.startDate)} – {formatDate(data.endDate)}
        </span>
      </div>
      {weekBased ? (
        <p className="text-sm text-muted-foreground">{data.weeks === 53 ? tf.weekBasedNote53 : tf.weekBasedNote}</p>
      ) : null}
    </>
  );
}

/** The calendar's periods once loaded; a spinner while loading, a retry when it failed. */
export function FiscalCalendarBody({
  calendar,
  generated,
  canChangeStatus,
  onChangeStatus,
}: Readonly<{
  calendar: FiscalCalendarResult;
  generated: GenerateFiscalPeriodsResult | null;
  canChangeStatus: boolean;
  onChangeStatus: (change: PendingStatusChange) => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const common = t.weldbooksUs.assets.common;
  const data = calendar.data;
  if (calendar.isLoading) return <PageLoader fullScreen={false} />;
  if (calendar.isError || !data) {
    return (
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
    );
  }
  const weekBased = data.kind === 'fifty_two_fifty_three';
  return (
    <div className="space-y-4">
      <FiscalSummary data={data} weekBased={weekBased} />

      <PeriodsTable
        data={data}
        weekBased={weekBased}
        canChangeStatus={canChangeStatus}
        onChangeStatus={onChangeStatus}
      />

      {generated ? (
        <p className="text-sm text-muted-foreground" data-testid="fiscal-generated">
          {fill(tf.generatedSummary, { created: generated.created.length, skipped: generated.skipped.length })}
        </p>
      ) : null}
    </div>
  );
}

/** Year choice, optional quarter / whole-year periods, and the button that creates the missing periods. */
export function FiscalControls({
  fiscalYear,
  yearOptions,
  includeQuarters,
  includeYear,
  canGenerate,
  generating,
  missing,
  hasData,
  onYearChange,
  onIncludeQuartersChange,
  onIncludeYearChange,
  onGenerate,
}: Readonly<{
  fiscalYear: number;
  yearOptions: number[];
  includeQuarters: boolean;
  includeYear: boolean;
  canGenerate: boolean;
  generating: boolean;
  missing: number;
  hasData: boolean;
  onYearChange: (year: number) => void;
  onIncludeQuartersChange: (value: boolean) => void;
  onIncludeYearChange: (value: boolean) => void;
  onGenerate: () => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="w-40 space-y-1.5">
        <Label htmlFor="fiscal-year">{tf.fiscalYear}</Label>
        <Select value={String(fiscalYear)} onValueChange={(value) => onYearChange(Number(value))}>
          <SelectTrigger id="fiscal-year">
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
        <p className="text-xs text-muted-foreground">{tf.fiscalYearHelp}</p>
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Checkbox id="fiscal-quarters" checked={includeQuarters} onCheckedChange={(checked) => onIncludeQuartersChange(checked === true)} />
        <Label htmlFor="fiscal-quarters" className="font-normal">
          {tf.includeQuarters}
        </Label>
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Checkbox id="fiscal-whole-year" checked={includeYear} onCheckedChange={(checked) => onIncludeYearChange(checked === true)} />
        <Label htmlFor="fiscal-whole-year" className="font-normal">
          {tf.includeYear}
        </Label>
      </div>
      {canGenerate ? (
        <Button onClick={onGenerate} disabled={generating || missing === 0 || !hasData} data-testid="fiscal-generate">
          {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {missing === 0 && hasData ? tf.nothingToCreate : fill(tf.generate, { count: missing })}
        </Button>
      ) : null}
    </div>
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
