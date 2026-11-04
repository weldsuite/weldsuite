import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { BaselineComparison } from '@weldsuite/app-api-client/domains/flow-approvals';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useBaselineComparison, useBaselines, useSignOffBaseline } from '@/hooks/queries/use-flow-approvals-queries';
import { slipLabel } from '@/app/weldflow/_approvals/lib';
import { formatDate, formatMoney } from '@/app/weldflow/_approvals/format';
import { barBox, overlayAxis, overlayRows, slippedItems, type OverlayRow } from './overlay-rows';

const LATEST = '__latest__';

function budgetKpiValue(budgetDelta: string | null | undefined, currency: string | null, language: Parameters<typeof formatMoney>[2]): string {
  if (!budgetDelta || Number(budgetDelta) === 0) return formatMoney(0, currency, language);
  const sign = Number(budgetDelta) > 0 ? '+' : '';
  return sign + formatMoney(budgetDelta, currency, language);
}

function currentBarColor(row: OverlayRow): string {
  if ((row.deltaDays ?? 0) > 0) return 'bg-destructive';
  if (row.change === 'removed') return 'bg-muted-foreground/30';
  return 'bg-primary';
}

/** KPI strip, variance rows and the dashed previews of one comparison (no data fetching). */
export function BaselineVariance({ comparison, currency }: Readonly<{ comparison: BaselineComparison; currency: string | null }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.baseline;
  const rows = useMemo(() => overlayRows(comparison, copy.kpi.goLive), [comparison, copy.kpi.goLive]);
  const axis = overlayAxis(rows);
  const goLiveSlip = slipLabel(comparison.diff.goLive.deltaDays);
  const budgetDelta = comparison.diff.budget.delta;

  const kpis = [
    { label: copy.kpi.goLive, value: goLiveSlip ?? '0d', tone: (comparison.diff.goLive.deltaDays ?? 0) > 0 },
    { label: copy.kpi.budget, value: budgetKpiValue(budgetDelta, currency, language), tone: Number(budgetDelta ?? 0) > 0 },
    { label: copy.kpi.slipped, value: String(slippedItems(rows)), tone: slippedItems(rows) > 0 },
    { label: copy.kpi.pending, value: String(comparison.pending.length), tone: false },
  ];

  return (
    <div className="space-y-3" data-testid="baseline-variance">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-md border px-3 py-2">
            <dt className="text-xs text-muted-foreground">{kpi.label}</dt>
            <dd className={cn('text-sm font-semibold', kpi.tone && 'text-destructive')}>{kpi.value}</dd>
          </div>
        ))}
      </dl>
      {axis ? (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <OverlayRowView key={row.id} row={row} axis={axis} />
          ))}
        </ul>
      ) : null}
      <p className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-muted-foreground/40" aria-hidden />{copy.legend.baseline}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm border border-dashed border-primary" aria-hidden />{copy.legend.pending}</span>
        {comparison.pending.map((p) => (
          <span key={p.changeRequestId}>{format(copy.pending, { code: p.code })}: {p.title}</span>
        ))}
      </p>
    </div>
  );
}

function OverlayRowView({ row, axis }: Readonly<{ row: OverlayRow; axis: { min: number; max: number } }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.baseline;
  const baseline = barBox(axis, row.baselineStart, row.baselineEnd);
  const current = barBox(axis, row.currentStart, row.currentEnd);
  const pending = row.pendingEnd ? barBox(axis, row.pendingEnd, row.pendingEnd) : null;
  const slip = slipLabel(row.deltaDays);
  return (
    <li className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs sm:grid-cols-[12rem_1fr]">
      <div className="min-w-0">
        <p className="truncate font-medium">{row.label}</p>
        {row.baselineEnd && row.change === 'moved' ? <p className="truncate text-muted-foreground">{format(copy.originalDate, { date: formatDate(row.baselineEnd, language) })}</p> : null}
      </div>
      <div className="relative h-6 rounded bg-muted/40">
        {baseline ? <span className="absolute top-0.5 h-1.5 rounded-sm bg-muted-foreground/40" style={{ left: `${baseline.left}%`, width: `${baseline.width}%` }} /> : null}
        {current ? (
          <span
            className={cn('absolute bottom-0.5 h-2 rounded-sm', currentBarColor(row))}
            style={{ left: `${current.left}%`, width: `${current.width}%` }}
          />
        ) : null}
        {pending ? <span className="absolute bottom-0 h-3 rounded-sm border border-dashed border-primary" style={{ left: `${pending.left}%`, width: `${Math.max(pending.width, 1.5)}%` }} title={row.pendingCode ?? undefined} /> : null}
        {slip ? (
          <span className="absolute right-1 top-0.5 text-[11px] font-medium text-destructive" data-testid="slip-label">
            {slip}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function SignOffPrompt({ canManage, pending, onSignOff }: Readonly<{ canManage: boolean; pending: boolean; onSignOff: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.baseline;
  return (
    <>
      <span className="text-xs text-muted-foreground">{copy.signOffHint}</span>
      {canManage ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={onSignOff}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {copy.signOff}
        </Button>
      ) : null}
    </>
  );
}

function VersionPicker({
  from,
  onChange,
  versions,
}: Readonly<{ from: string; onChange: (value: string) => void; versions: NonNullable<ReturnType<typeof useBaselines>['data']> }>) {
  const { t, format } = useI18n();
  const copy = t.flowApprovals.baseline;
  return (
    <div className="ml-auto flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{copy.picker}</span>
      <Select value={from} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-32" aria-label={copy.picker}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LATEST}>{format(copy.version, { version: String(versions[0]?.version ?? 1) })}</SelectItem>
          {versions.slice(1).map((baseline) => (
            <SelectItem key={baseline.id} value={baseline.id}>
              {format(copy.version, { version: String(baseline.version) })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ComparisonBody({ comparison, currency }: Readonly<{ comparison: ReturnType<typeof useBaselineComparison>; currency: string | null }>) {
  const { t } = useI18n();
  if (comparison.isLoading) return <Loader2 className="mx-auto animate-spin text-muted-foreground" aria-hidden />;
  if (comparison.data) return <BaselineVariance comparison={comparison.data} currency={currency} />;
  return <p className="text-sm text-muted-foreground">{t.flowApprovals.baseline.loadFailed}</p>;
}

interface BaselineOverlayProps {
  projectId: string;
  currency: string | null;
  /** Project managers sign off the baseline. */
  canManage: boolean;
}

/** The Gantt tab's baseline strip: version picker, KPIs, variance rows, and the sign-off while there is no baseline. */
export function BaselineOverlay({ projectId, currency, canManage }: Readonly<BaselineOverlayProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.baseline;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<string>(LATEST);
  const baselines = useBaselines(projectId);
  const signOff = useSignOffBaseline(projectId);
  const hasBaseline = (baselines.data?.length ?? 0) > 0;
  const comparison = useBaselineComparison({ projectId, from: from === LATEST ? undefined : from }, open && hasBaseline);

  if (baselines.isLoading || baselines.isError) return null;

  const onSignOff = async () => {
    try {
      await signOff.mutateAsync();
      toast.success(copy.signedOff);
    } catch (error) {
      toast.error(isApiError(error) && error.message ? error.message : copy.signOffFailed);
    }
  };

  return (
    <section className="border-b bg-background px-4 py-2" data-testid="baseline-overlay">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="flex items-center gap-1 text-sm font-medium" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!hasBaseline}>
          {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
          {copy.title}
          {hasBaseline ? <span className="text-muted-foreground">v{baselines.data?.[0]?.version}</span> : null}
        </button>
        {hasBaseline ? null : <SignOffPrompt canManage={canManage} pending={signOff.isPending} onSignOff={() => void onSignOff()} />}
        {hasBaseline && open ? <VersionPicker from={from} onChange={setFrom} versions={baselines.data ?? []} /> : null}
      </div>
      {open && hasBaseline ? (
        <div className="mt-3 max-h-72 overflow-y-auto pb-2">
          <ComparisonBody comparison={comparison} currency={currency} />
        </div>
      ) : null}
    </section>
  );
}
