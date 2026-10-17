/**
 * The line chart of Stripe's dashboard, on the shadcn chart container: the
 * period as a solid 2px line, the comparison as a dashed grey one, straight
 * segments (no smoothing, no area fill) and only the first and last x label,
 * pinned to the chart's edges.
 *
 * - `hero` is the "Today" chart: no y axis and no grid, just the baseline.
 * - `card` is an overview card chart: light horizontal grid lines with the
 *   y labels on the right.
 *
 * A point without a value is a gap, so a running total stops at "now".
 */

import { Line, LineChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import type { SeriesPoint } from './dashboard-series';
import { MoneyTooltipRow } from './money-tooltip-row';
import { useChartFormat } from './use-chart-format';

export const CURRENT_COLOR = 'var(--chart-1)';
export const COMPARISON_COLOR = 'var(--muted-foreground)';

type Props = Readonly<{
  points: SeriesPoint[];
  variant: 'hero' | 'card';
  label: string;
  compareLabel: string;
  /** The text under each x end, from a `YYYY-MM` key. */
  formatTick: (month: string) => string;
  className?: string;
}>;

export function ComparisonLineChart({ points, variant, label, compareLabel, formatTick, className }: Props) {
  const format = useChartFormat();
  const config = {
    value: { label, color: CURRENT_COLOR },
    compareValue: { label: compareLabel, color: COMPARISON_COLOR },
  } satisfies ChartConfig;
  const first = points[0]?.month;
  const last = points[points.length - 1]?.month;
  const hasComparison = points.some((p) => p.compareValue !== undefined);
  const card = variant === 'card';

  return (
    <ChartContainer config={config} className={className}>
      <LineChart accessibilityLayer data={points} margin={{ top: 8, left: 0, right: 0, bottom: 0 }}>
        {card && <CartesianGrid vertical={false} stroke="var(--border)" />}
        <YAxis
          hide={!card}
          orientation="right"
          width={card ? 52 : 0}
          tickCount={4}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
          tickFormatter={format.compactMoney}
          domain={[(min: number) => Math.min(0, min), (max: number) => (max > 0 ? max : 1)]}
        />
        <XAxis
          dataKey="month"
          ticks={first && last ? [first, last] : []}
          interval={0}
          tickLine={false}
          axisLine={card ? false : { stroke: 'var(--border)' }}
          tick={({ x, y, payload, index }: { x: number; y: number; payload: { value: string }; index: number }) => (
            <text x={x} y={y + 14} textAnchor={index === 0 ? 'start' : 'end'} className="fill-muted-foreground text-[11px]">
              {formatTick(payload.value)}
            </text>
          )}
        />
        <ChartTooltip
          cursor={{ stroke: 'var(--border)' }}
          // The dashed line is drawn first so it sits under the solid one; list the period first anyway.
          itemSorter={(item) => (item.dataKey === 'value' ? 0 : 1)}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, name, item) => {
                const point = item.payload as SeriesPoint;
                const isCurrent = name === 'value';
                return (
                  <MoneyTooltipRow
                    label={format.monthLong((isCurrent ? point.month : point.compareMonth) ?? '')}
                    color={isCurrent ? CURRENT_COLOR : COMPARISON_COLOR}
                    dashed={!isCurrent}
                    value={format.formatMoney(Number(value))}
                  />
                );
              }}
            />
          }
        />
        {hasComparison && (
          <Line
            dataKey="compareValue"
            type="linear"
            stroke="var(--color-compareValue)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            activeDot={{ r: 3, fill: COMPARISON_COLOR, stroke: 'var(--background)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        )}
        <Line
          dataKey="value"
          type="linear"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: CURRENT_COLOR, stroke: 'var(--background)', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
