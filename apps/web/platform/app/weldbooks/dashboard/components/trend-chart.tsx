/**
 * The headline chart, laid out like Stripe's "Today" chart: no card, grid or
 * y axis; a metric picker with the range total, a comparison picker with the
 * comparison total, the range as a solid line, the comparison as a dashed one,
 * and only the first and last month on the x axis.
 *
 * Figures are the ledger profit & loss (net of VAT). `monthlyTrend` carries 24
 * months, so a 12-month range still has a previous period to compare with. An
 * API without it only has 12 months of revenue: the picker then offers revenue
 * alone and a comparison the data cannot cover shows a dash and no line.
 */

import { useMemo, useState } from 'react';
import { Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChevronDown } from 'lucide-react';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useChartFormat } from './use-chart-format';
import { MoneyTooltipRow } from './money-tooltip-row';

const RANGES = ['3', '6', '12'] as const;
type Range = (typeof RANGES)[number];
type Metric = 'revenue' | 'expenses' | 'profit';
type Compare = 'previousPeriod' | 'previousYear';
type Month = { month: string; revenue: number; expenses: number; profit: number };
type Point = { month: string; value: number; compareMonth?: string; compareValue?: number };

const CURRENT = 'var(--chart-1)';
const COMPARISON = 'var(--muted-foreground)';

export function TrendChart({ dashboard }: Readonly<{ dashboard: Dashboard }>) {
  const { t } = useI18n();
  const tc = t.accounting.dashboard.charts;
  const format = useChartFormat();
  const [range, setRange] = useState<Range>('12');
  const [metric, setMetric] = useState<Metric>('revenue');
  const [compare, setCompare] = useState<Compare>('previousPeriod');

  const hasTrend = Boolean(dashboard.monthlyTrend?.length);
  const months = useMemo<Month[]>(
    () =>
      dashboard.monthlyTrend?.length
        ? dashboard.monthlyTrend.map((m) => ({
            month: m.month,
            revenue: Number(m.revenue),
            expenses: Number(m.expenses),
            profit: Number(m.profit),
          }))
        : (dashboard.monthlyRevenue ?? []).map((m) => ({ month: m.month, revenue: Number(m.total), expenses: 0, profit: 0 })),
    [dashboard.monthlyTrend, dashboard.monthlyRevenue],
  );
  const activeMetric: Metric = hasTrend ? metric : 'revenue';

  const points = useMemo<Point[]>(() => {
    const size = Math.min(Number(range), months.length);
    const shift = compare === 'previousPeriod' ? size : 12;
    const start = months.length - size;
    return months.slice(start).map((m, i) => {
      const before = months[start + i - shift];
      return {
        month: m.month,
        value: m[activeMetric],
        compareMonth: before?.month,
        compareValue: before?.[activeMetric],
      };
    });
  }, [months, range, compare, activeMetric]);

  const metricLabels: Record<Metric, string> = { revenue: tc.revenue, expenses: tc.expenses, profit: tc.netProfit };
  const compareLabels: Record<Compare, string> = { previousPeriod: tc.previousPeriod, previousYear: tc.previousYear };
  const config = {
    value: { label: metricLabels[activeMetric], color: CURRENT },
    compareValue: { label: compareLabels[compare], color: COMPARISON },
  } satisfies ChartConfig;

  const total = points.reduce((sum, p) => sum + p.value, 0);
  const comparable = points.length > 0 && points.every((p) => p.compareValue !== undefined);
  const compareTotal = points.reduce((sum, p) => sum + (p.compareValue ?? 0), 0);
  const first = points[0];
  const last = points[points.length - 1];
  const span = (from?: string, to?: string) => (from && to ? `${format.monthYear(from)} – ${format.monthYear(to)}` : '');

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap gap-x-16 gap-y-4">
          <div className="space-y-1">
            <Picker
              value={activeMetric}
              labels={metricLabels}
              options={hasTrend ? ['revenue', 'expenses', 'profit'] : ['revenue']}
              onChange={(v) => setMetric(v as Metric)}
            />
            <p className={`text-xl tabular-nums ${total < 0 ? 'text-destructive' : ''}`}>{format.formatMoney(total)}</p>
            <p className="text-xs text-muted-foreground">{span(first?.month, last?.month)}</p>
          </div>
          <div className="space-y-1">
            <Picker
              value={compare}
              labels={compareLabels}
              options={['previousPeriod', 'previousYear']}
              onChange={(v) => setCompare(v as Compare)}
            />
            <p className="text-xl tabular-nums text-muted-foreground">{comparable ? format.formatMoney(compareTotal) : '—'}</p>
            <p className="text-xs text-muted-foreground">{comparable ? span(first?.compareMonth, last?.compareMonth) : tc.noComparison}</p>
          </div>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => v && setRange(v as Range)}>
          {RANGES.map((r) => (
            <ToggleGroupItem key={r} value={r} className="px-3">
              {tc.monthsShort.replace('{count}', r)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
        <LineChart accessibilityLayer data={points} margin={{ top: 8, left: 0, right: 0, bottom: 0 }}>
          <YAxis hide domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(max, 1)]} />
          <XAxis
            dataKey="month"
            ticks={first && last ? [first.month, last.month] : []}
            interval={0}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            tick={({ x, y, payload, index }: { x: number; y: number; payload: { value: string }; index: number }) => (
              <text
                x={x}
                y={y + 14}
                textAnchor={index === 0 ? 'start' : 'end'}
                className="fill-muted-foreground text-xs"
              >
                {format.monthYear(payload.value)}
              </text>
            )}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            // The dashed line is drawn first so it sits under the solid one; list the current month first anyway.
            itemSorter={(item) => (item.dataKey === 'value' ? 0 : 1)}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name, item) => {
                  const point = item.payload as Point;
                  const isCurrent = name === 'value';
                  return (
                    <MoneyTooltipRow
                      label={format.monthLong((isCurrent ? point.month : point.compareMonth) ?? '')}
                      color={isCurrent ? CURRENT : COMPARISON}
                      value={format.formatMoney(Number(value))}
                    />
                  );
                }}
              />
            }
          />
          <Line
            dataKey="compareValue"
            type="linear"
            stroke="var(--color-compareValue)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Line dataKey="value" type="linear" stroke="var(--color-value)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ChartContainer>
    </section>
  );
}

/** Stripe's figure label: plain text with a chevron that opens the choices. */
function Picker<T extends string>({
  value,
  labels,
  options,
  onChange,
}: Readonly<{ value: T; labels: Record<T, string>; options: T[]; onChange: (value: string) => void }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1 text-sm font-medium outline-none hover:text-foreground/80">
        {labels[value]}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {labels[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
