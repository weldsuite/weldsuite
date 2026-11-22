/**
 * Line or bar chart over time on the library's `ChartContainer` (recharts).
 * Series come as columns of `data`; a series with `dashed` is drawn dotted
 * (the previous period).
 *
 * Annotations: where the WeldPanel layout turns them on and the points carry
 * their `bucket`, the project's annotations (and the open report's own) show
 * as round markers along the bottom of the chart (`chart-annotations.tsx`).
 */

import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCompact, formatNumber } from '../../lib/format';
import { ChartAnnotations, annotationChartClick, annotationMarkLines, annotationTooltipActive, type ChartAnnotationsApi } from './chart-annotations';

export interface ChartSeries {
  key: string;
  label: string;
  dashed?: boolean;
  /** CSS color; defaults to the chart palette by position. */
  color?: string;
}

/**
 * One point on the x axis. `bucket` is the start of the hour, day, week or
 * month it counts (the result's `bucket`, `2026-03-01`): set it and the chart
 * can place annotations and add one on click.
 */
export type ChartDatum = { label: string; bucket?: string } & Record<string, string | number | null>;

interface TimeSeriesChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  type?: 'line' | 'bar';
  locale: string;
  className?: string;
  /** Hide the legend for a single series. */
  legend?: boolean;
  /** Horizontal lines at fixed values (an alert's threshold or band), labelled. */
  guides?: { value: number; label: string }[];
}

export function seriesColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`;
}

function ChartBody({ data, series, type = 'line', locale, className, legend, guides = [], annotations }: Readonly<TimeSeriesChartProps & { annotations: ChartAnnotationsApi }>) {
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: s.color ?? seriesColor(i) }]));
  const showLegend = legend ?? series.length > 1;
  const onClick = annotationChartClick(annotations, data);
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
      <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => formatCompact(v, locale)} />
      <ChartTooltip
        active={annotationTooltipActive(annotations)}
        content={<ChartTooltipContent formatter={(value) => <span className="font-mono font-medium tabular-nums">{formatNumber(Number(value), locale)}</span>} />}
      />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      {guides.map((guide) => (
        <ReferenceLine
          key={`guide:${guide.label}`}
          y={guide.value}
          stroke="var(--destructive)"
          strokeDasharray="4 4"
          ifOverflow="extendDomain"
          label={{ value: guide.label, position: 'insideTopRight', fill: 'var(--muted-foreground)', fontSize: 11 }}
        />
      ))}
      {annotationMarkLines(annotations)}
    </>
  );

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-64 w-full', onClick && 'cursor-crosshair', className)}>
      {type === 'bar' ? (
        <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} onClick={onClick}>
          {common}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={[3, 3, 0, 0]} fillOpacity={s.dashed ? 0.45 : 1} />
          ))}
        </BarChart>
      ) : (
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }} onClick={onClick}>
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

export function TimeSeriesChart(props: Readonly<TimeSeriesChartProps>) {
  return <ChartAnnotations rows={props.data}>{(annotations) => <ChartBody {...props} annotations={annotations} />}</ChartAnnotations>;
}
