/**
 * Line or bar chart over time on the library's `ChartContainer` (recharts).
 * Series come as columns of `data`; a series with `dashed` is drawn dotted
 * (the previous period).
 */

import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCompact, formatNumber } from '../../lib/format';

export interface ChartSeries {
  key: string;
  label: string;
  dashed?: boolean;
  /** CSS color; defaults to the chart palette by position. */
  color?: string;
}

export type ChartDatum = { label: string } & Record<string, string | number | null>;

interface TimeSeriesChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  type?: 'line' | 'bar';
  locale: string;
  className?: string;
  /** Hide the legend for a single series. */
  legend?: boolean;
}

export function seriesColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`;
}

export function TimeSeriesChart({ data, series, type = 'line', locale, className, legend }: Readonly<TimeSeriesChartProps>) {
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: s.color ?? seriesColor(i) }]));
  const showLegend = legend ?? series.length > 1;
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
      <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => formatCompact(v, locale)} />
      <ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-mono font-medium tabular-nums">{formatNumber(Number(value), locale)}</span>} />} />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
    </>
  );

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-64 w-full', className)}>
      {type === 'bar' ? (
        <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          {common}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={[3, 3, 0, 0]} fillOpacity={s.dashed ? 0.45 : 1} />
          ))}
        </BarChart>
      ) : (
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          {common}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              dot={data.length <= 2}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
