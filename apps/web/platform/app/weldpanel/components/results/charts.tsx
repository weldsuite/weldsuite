/**
 * The extra chart shapes of the analysis views, on the library's
 * `ChartContainer` (recharts) like `charts/time-series-chart.tsx`: a stacked
 * area chart (Insights "area"), a pie of totals, bars over categories (stacked
 * or not: lifecycle, stickiness, histograms) and a line chart with a value
 * formatter and optional reference lines (retention curve, conversion over
 * time, web vitals with their thresholds).
 */

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCompact, formatNumber } from '../../lib/format';

export interface ExploreSeries {
  key: string;
  label: string;
  /** CSS color; defaults to the chart palette by position. */
  color?: string;
}

export type ExploreDatum = { label: string } & Record<string, string | number | null>;

export function paletteColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`;
}

function chartConfig(series: readonly ExploreSeries[]): ChartConfig {
  return Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: s.color ?? paletteColor(i) }]));
}

function tooltip(format: (value: number) => string) {
  return <ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-mono font-medium tabular-nums">{format(Number(value))}</span>} />} />;
}

interface CartesianProps {
  data: ExploreDatum[];
  series: ExploreSeries[];
  locale: string;
  className?: string;
  /** Tooltip and axis text; numbers by default. */
  format?: (value: number) => string;
  /** Axis ticks when they differ from the tooltip (compact numbers by default). */
  axisFormat?: (value: number) => string;
  legend?: boolean;
}

/** Stacked areas over time: each series on top of the one before. */
export function StackedAreaChart({ data, series, locale, className, format, axisFormat, legend }: Readonly<CartesianProps>) {
  const fmt = format ?? ((v: number) => formatNumber(v, locale));
  return (
    <ChartContainer config={chartConfig(series)} className={cn('aspect-auto h-64 w-full', className)}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={axisFormat ?? ((v: number) => formatCompact(v, locale))} />
        {tooltip(fmt)}
        {(legend ?? series.length > 1) && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stackId="stack"
            stroke={`var(--color-${s.key})`}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.35}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

/** A type, not an interface: recharts wants rows it can index. */
export type PieSlice = {
  key: string;
  label: string;
  value: number;
};

/** A pie (donut) of totals, largest first; negative and zero totals are left out. */
export function TotalsPieChart({ slices, locale, className, format }: Readonly<{ slices: PieSlice[]; locale: string; className?: string; format?: (value: number) => string }>) {
  const shown = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const series = shown.map((s) => ({ key: s.key, label: s.label }));
  const fmt = format ?? ((v: number) => formatNumber(v, locale));
  return (
    <ChartContainer config={chartConfig(series)} className={cn('aspect-auto h-64 w-full', className)}>
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="key" formatter={(value) => <span className="font-mono font-medium tabular-nums">{fmt(Number(value))}</span>} />} />
        <Pie data={shown} dataKey="value" nameKey="key" innerRadius="45%" outerRadius="80%" paddingAngle={1} isAnimationActive={false}>
          {shown.map((slice, index) => (
            <Cell key={slice.key} fill={paletteColor(index)} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
      </PieChart>
    </ChartContainer>
  );
}

interface BarProps extends CartesianProps {
  /** Stack the series on one bar per category (lifecycle draws dormant below zero). */
  stacked?: boolean;
}

/** Bars over categories (buckets, periods). */
export function CategoryBarChart({ data, series, locale, className, format, axisFormat, legend, stacked = false }: Readonly<BarProps>) {
  const fmt = format ?? ((v: number) => formatNumber(v, locale));
  return (
    <ChartContainer config={chartConfig(series)} className={cn('aspect-auto h-64 w-full', className)}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} stackOffset={stacked ? 'sign' : undefined}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={axisFormat ?? ((v: number) => formatCompact(v, locale))} />
        {tooltip(fmt)}
        {(legend ?? series.length > 1) && <ChartLegend content={<ChartLegendContent />} />}
        {stacked && <ReferenceLine y={0} stroke="var(--border)" />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} stackId={stacked ? 'stack' : undefined} fill={`var(--color-${s.key})`} radius={stacked ? 0 : [3, 3, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

export interface ChartReferenceLine {
  y: number;
  label: string;
  color: string;
}

interface LineProps extends CartesianProps {
  referenceLines?: ChartReferenceLine[];
  /** Fixed y range, e.g. `[0, 1]` for shares. */
  yDomain?: [number, number];
}

/** Lines over categories with a value formatter (percentages, milliseconds). */
export function ValueLineChart({ data, series, locale, className, format, axisFormat, legend, referenceLines = [], yDomain }: Readonly<LineProps>) {
  const fmt = format ?? ((v: number) => formatNumber(v, locale));
  return (
    <ChartContainer config={chartConfig(series)} className={cn('aspect-auto h-64 w-full', className)}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={52} domain={yDomain} tickFormatter={axisFormat ?? fmt} />
        {tooltip(fmt)}
        {(legend ?? series.length > 1) && <ChartLegend content={<ChartLegendContent />} />}
        {referenceLines.map((line) => (
          <ReferenceLine key={line.label} y={line.y} stroke={line.color} strokeDasharray="4 4" label={{ value: line.label, position: 'insideTopRight', fontSize: 11, fill: line.color }} />
        ))}
        {series.map((s) => (
          <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={2} dot={data.length <= 2} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
