/**
 * The S-curve: planned value, earned value and actual cost by week, with the
 * budget and the forecast. Drawn like the WeldBooks dashboard's "Today" chart:
 * the figures above it as its legend, then straight 2px lines on a bare plot
 * (no y axis, no grid, just the baseline), the first and last date pinned to
 * its edges and a tooltip that follows the pointer.
 */

import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import type { FinanceSnapshot, ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { FOLLOWING_TOOLTIP_PROPS, FollowingTooltip } from '@/app/weldbooks/dashboard/components/following-tooltip';
import { MoneyTooltipRow } from '@/app/weldbooks/dashboard/components/money-tooltip-row';
import { buildCurve, formatMoney, formatPercent, type CurvePoint } from '../_lib/finance';
import { useFinanceEnv } from './finance-parts';

type Series = 'planned' | 'earned' | 'actual' | 'forecast';

/** The plan is the reference, dashed grey like WeldBooks' comparison; the forecast continues the actual cost, dashed. */
const COLORS: Record<Series, string> = {
  planned: 'var(--muted-foreground)',
  earned: 'var(--chart-1)',
  actual: '#ea580c',
  forecast: '#ea580c',
};
const DASHED: Record<Series, boolean> = { planned: true, earned: false, actual: false, forecast: true };
const SERIES: readonly Series[] = ['planned', 'earned', 'actual', 'forecast'];
/** The axis labels: the page's caption style (muted, 12px). */
const AXIS_LABEL = 'fill-muted-foreground text-xs tabular-nums';
/** A 1px rule's y on the middle of a pixel row, so the baseline is one sharp row (as on the WeldBooks chart). */
const onPixelRow = (y: number) => Math.round(y - 0.5) + 0.5;

/** A short line in a series' colour, dashed where the chart's line is. */
function Swatch({ series }: Readonly<{ series: Series }>) {
  return (
    <span
      aria-hidden
      className="w-3 shrink-0 border-t-2"
      style={{ borderColor: COLORS[series], borderStyle: DASHED[series] ? 'dashed' : 'solid' }}
    />
  );
}

/** One figure above the chart: its series' swatch and label, then the amount. */
function Figure({ series, label, value }: Readonly<{ series: Series; label: string; value: string }>) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Swatch series={series} />
        {label}
      </p>
      <p className="text-xl tabular-nums">{value}</p>
    </div>
  );
}

/** A date string as epoch ms, or null when missing or not a date. */
function toMs(date: string | null | undefined): number | null {
  const ms = date ? new Date(date).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function CurveChart({
  finance,
  snapshots,
  startDate,
  endDate,
}: Readonly<{ finance: ProjectFinance; snapshots: readonly FinanceSnapshot[]; startDate: string | null; endDate: string | null }>) {
  const { copy, format, intlLocale } = useFinanceEnv();
  const c = copy.overview.chart;
  const now = useMemo(() => new Date(finance.asOf).getTime(), [finance.asOf]);
  const startMs = toMs(startDate);
  const endMs = toMs(endDate);
  const curve = useMemo(() => buildCurve(snapshots, finance, endMs, now, startMs), [snapshots, finance, endMs, now, startMs]);
  const first = curve.points[0]?.t;
  const last = curve.points.at(-1)?.t;
  // The year only when the curve runs over New Year.
  const withYear = first !== undefined && last !== undefined && new Date(first).getFullYear() !== new Date(last).getFullYear();

  const amount = (n: number) => (curve.percent ? `${formatPercent(n, intlLocale)}%` : formatMoney(String(n), finance.currency, intlLocale));
  const value = (n: number | null | undefined): string => (n === null || n === undefined ? '–' : amount(n));
  const date = (t: number) =>
    new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined }).format(new Date(t));

  const current = curve.points.find((p) => p.t === now);
  const label = format(c.label, { planned: value(current?.planned), earned: value(current?.earned), actual: value(current?.actual) });
  const hasCurve = curve.budget !== null;
  const names: Record<Series, string> = { planned: c.planned, earned: c.earned, actual: c.actual, forecast: c.forecast };
  const config = Object.fromEntries(SERIES.map((series) => [series, { label: names[series], color: COLORS[series] }])) satisfies ChartConfig;

  return (
    <section aria-label={c.title} className="min-w-0 space-y-6">
      <div className="flex flex-wrap gap-x-16 gap-y-4">
        <Figure series="planned" label={c.plannedByToday} value={value(current?.planned)} />
        <Figure series="earned" label={c.done} value={value(current?.earned)} />
        <Figure series="actual" label={c.spent} value={value(current?.actual)} />
        {curve.forecast === null ? null : <Figure series="forecast" label={c.forecast} value={value(curve.forecast)} />}
      </div>

      {hasCurve ? (
        <div role="img" aria-label={label}>
          <ChartContainer config={config} className="aspect-auto h-[440px] w-full">
            <LineChart accessibilityLayer data={curve.points} margin={{ top: 20, left: 0, right: 0, bottom: 0 }}>
              <CartesianGrid
                vertical={false}
                stroke="var(--border)"
                horizontalCoordinatesGenerator={({ offset }: { offset: { top?: number; height?: number } }) => [
                  onPixelRow((offset.top ?? 0) + (offset.height ?? 0)),
                ]}
              />
              {/* A tenth of headroom, so the top line and the budget's label clear the top edge. */}
              <YAxis hide width={0} domain={[0, (max: number) => (max > 0 ? max * 1.1 : 1)]} />
              <XAxis
                type="number"
                dataKey="t"
                scale="time"
                domain={['dataMin', 'dataMax']}
                ticks={first !== undefined && last !== undefined ? [first, last] : []}
                interval={0}
                tickLine={false}
                axisLine={false}
                tick={({ x, y, payload, index }: { x: number; y: number; payload: { value: number }; index: number }) => (
                  <text x={x} y={y + 14} textAnchor={index === 0 ? 'start' : 'end'} className={AXIS_LABEL}>
                    {date(payload.value)}
                  </text>
                )}
              />
              <ChartTooltip
                {...FOLLOWING_TOOLTIP_PROPS}
                cursor={{ stroke: 'var(--border)' }}
                content={(props) => (
                  <FollowingTooltip active={props.active} coordinate={props.coordinate}>
                    <ChartTooltipContent
                      active={props.active}
                      payload={(props.payload ?? []).filter((item) => item.value !== null && item.value !== undefined)}
                      labelFormatter={(_, payload) => date(Number((payload?.[0]?.payload as CurvePoint | undefined)?.t))}
                      formatter={(n, name) => {
                        const series = name as Series;
                        return <MoneyTooltipRow label={names[series]} color={COLORS[series]} dashed={DASHED[series]} value={value(Number(n))} />;
                      }}
                    />
                  </FollowingTooltip>
                )}
              />
              {curve.budget === null ? null : (
                <ReferenceLine
                  y={curve.budget}
                  ifOverflow="extendDomain"
                  stroke="var(--border)"
                  strokeDasharray="2 4"
                  label={{
                    value: curve.percent ? c.budgetPercent : format(c.budget, { amount: value(curve.budget) }),
                    position: 'insideTopLeft',
                    className: AXIS_LABEL,
                  }}
                />
              )}
              {SERIES.map((series) => (
                <Line
                  key={series}
                  dataKey={series}
                  type="linear"
                  stroke={`var(--color-${series})`}
                  strokeWidth={DASHED[series] ? 1.5 : 2}
                  strokeDasharray={DASHED[series] ? '4 4' : undefined}
                  dot={false}
                  activeDot={{ r: 4, fill: COLORS[series], stroke: 'var(--background)', strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">{c.empty}</p>
      )}
    </section>
  );
}
