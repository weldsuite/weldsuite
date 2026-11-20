/**
 * A chart from a `show_chart` spec, on the library's `ChartContainer`
 * (recharts). Series take the theme's chart colours in order; a click on a
 * bar, point or slice asks about it when the chat allows it.
 */

import { useMemo, type Ref } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
  type MouseHandlerDataParam,
} from 'recharts';
import type { ChartVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import { cn } from '@/lib/utils';
import { formatNumber } from './format';

/** Pie and donut charts show at most this many slices; the rest are added up as "Other". */
const MAX_SLICES = 8;

/** The theme's five chart colours, then lighter mixes of them. */
export function seriesColor(index: number): string {
  const base = `var(--chart-${(index % 5) + 1})`;
  return index < 5 ? base : `color-mix(in oklch, ${base} 55%, var(--background))`;
}

/** Recharts rows: `label` plus one column per series (`s0`, `s1`, …: the names may hold any character). */
function toRows(visual: ChartVisual): Array<Record<string, string | number | null>> {
  return visual.labels.map((label, i) => {
    const row: Record<string, string | number | null> = { label };
    visual.series.forEach((s, j) => {
      row[`s${j}`] = s.values[i] ?? null;
    });
    return row;
  });
}

type Slice = {
  label: string;
  value: number;
  /** Index into the labels, or -1 for the "Other" slice. */
  index: number;
};

/** The first series as pie slices: positive values, largest kept, the rest summed. */
export function toSlices(visual: ChartVisual, otherLabel: string): Slice[] {
  const values = visual.series[0]?.values ?? [];
  const slices = visual.labels
    .map((label, index) => ({ label, value: values[index] ?? 0, index }))
    .filter((slice) => slice.value > 0);
  if (slices.length <= MAX_SLICES) return slices;
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, MAX_SLICES - 1);
  const rest = sorted.slice(MAX_SLICES - 1).reduce((sum, slice) => sum + slice.value, 0);
  return [...kept.sort((a, b) => a.index - b.index), { label: otherLabel, value: rest, index: -1 }];
}

export interface ChartPick {
  label: string;
  /** Set when the chart has one value per label (one series, or a slice). */
  value?: number;
}

interface VisualChartProps {
  visual: ChartVisual;
  locale: string;
  /** Taller, for the expanded view. */
  expanded?: boolean;
  /** A bar, point or slice was clicked. */
  onPick?: (pick: ChartPick) => void;
  /** The chart's SVG, for the PNG download. */
  surfaceRef?: Ref<HTMLDivElement>;
  otherLabel: string;
}

export function VisualChart({ visual, locale, expanded = false, onPick, surfaceRef, otherLabel }: Readonly<VisualChartProps>) {
  const config = useMemo<ChartConfig>(() => {
    if (visual.kind === 'pie' || visual.kind === 'donut') {
      return { value: { label: visual.series[0]?.name ?? visual.title } };
    }
    return Object.fromEntries(visual.series.map((s, i) => [`s${i}`, { label: s.name, color: seriesColor(i) }]));
  }, [visual]);
  const rows = useMemo(() => toRows(visual), [visual]);
  const format = (value: number, compact = false) => formatNumber(value, visual.format, locale, { compact });
  const height = expanded ? 'h-[min(60vh,420px)]' : 'h-56';
  const single = visual.series.length === 1;

  const pickIndex = (index: number) => {
    if (!onPick || !Number.isInteger(index) || index < 0 || index >= visual.labels.length) return;
    const value = single ? visual.series[0].values[index] : null;
    onPick({ label: visual.labels[index], ...(typeof value === 'number' ? { value } : {}) });
  };
  const onChartClick = onPick
    ? (state: MouseHandlerDataParam) => pickIndex(Number(state.activeTooltipIndex))
    : undefined;

  const tooltip = (
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value, name, item) => (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: (item as { color?: string }).color ?? (item.payload as { fill?: string })?.fill }}
                />
                {config[String(name)]?.label ?? (item.payload as { label?: string })?.label ?? name}
              </span>
              <span className="font-mono font-medium tabular-nums text-foreground">{format(Number(value))}</span>
            </div>
          )}
        />
      }
    />
  );

  if (visual.kind === 'pie' || visual.kind === 'donut') {
    const slices = toSlices(visual, otherLabel);
    return (
      <div ref={surfaceRef}>
        <ChartContainer config={config} className={cn('aspect-auto w-full', height, onPick && 'cursor-pointer')}>
          <PieChart>
            {tooltip}
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius={visual.kind === 'donut' ? '55%' : 0}
              outerRadius="85%"
              strokeWidth={2}
              stroke="var(--background)"
              isAnimationActive={false}
              onClick={(_: unknown, index: number) => {
                const slice = slices[index];
                if (slice && slice.index >= 0) pickIndex(slice.index);
              }}
            >
              {slices.map((slice, i) => (
                <Cell key={`${slice.label}-${slice.index}`} fill={seriesColor(i)} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {slices.map((slice, i) => (
            <li key={`${slice.label}-${slice.index}`} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: seriesColor(i) }} />
              {slice.label}
              <span className="tabular-nums text-foreground">{format(slice.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const horizontal = visual.kind === 'bar' && visual.horizontal === true;
  const legend = visual.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null;
  const valueAxis = (
    <YAxis
      tickLine={false}
      axisLine={false}
      width={48}
      tickFormatter={(v: number) => format(v, true)}
    />
  );
  const labelAxis = <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />;
  const margin = { left: 0, right: 8, top: 8, bottom: 0 };
  const stackId = visual.stacked ? 'stack' : undefined;
  const container = cn('aspect-auto w-full', height, onPick && 'cursor-pointer');

  let chart;
  if (visual.kind === 'bar' && horizontal) {
    chart = (
      <BarChart data={rows} layout="vertical" margin={margin} onClick={onChartClick}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => format(v, true)} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={96} />
        {tooltip}
        {legend}
        {visual.series.map((_, i) => (
          <Bar key={i} dataKey={`s${i}`} stackId={stackId} fill={`var(--color-s${i})`} radius={stackId ? 0 : [0, 3, 3, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  } else if (visual.kind === 'bar') {
    chart = (
      <BarChart data={rows} margin={margin} onClick={onChartClick}>
        <CartesianGrid vertical={false} />
        {labelAxis}
        {valueAxis}
        {tooltip}
        {legend}
        {visual.series.map((_, i) => (
          <Bar key={i} dataKey={`s${i}`} stackId={stackId} fill={`var(--color-s${i})`} radius={stackId ? 0 : [3, 3, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  } else if (visual.kind === 'area') {
    chart = (
      <AreaChart data={rows} margin={margin} onClick={onChartClick}>
        <CartesianGrid vertical={false} />
        {labelAxis}
        {valueAxis}
        {tooltip}
        {legend}
        {visual.series.map((_, i) => (
          <Area
            key={i}
            dataKey={`s${i}`}
            type="monotone"
            stackId={stackId}
            stroke={`var(--color-s${i})`}
            fill={`var(--color-s${i})`}
            fillOpacity={0.25}
            strokeWidth={2}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart data={rows} margin={margin} onClick={onChartClick}>
        <CartesianGrid vertical={false} />
        {labelAxis}
        {valueAxis}
        {tooltip}
        {legend}
        {visual.series.map((_, i) => (
          <Line
            key={i}
            dataKey={`s${i}`}
            type="monotone"
            stroke={`var(--color-s${i})`}
            strokeWidth={2}
            dot={visual.labels.length <= 12}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }

  return (
    <div ref={surfaceRef}>
      <ChartContainer config={config} className={container}>
        {chart}
      </ChartContainer>
    </div>
  );
}

/**
 * The chart's numbers as a table for screen readers (the chart itself is a
 * picture). Hidden by a wrapping block: `sr-only` on the table itself does not
 * shrink it (a table ignores `overflow`), and its full height would add
 * invisible scroll room under the chat.
 */
export function ChartDataTable({ visual, locale }: Readonly<{ visual: ChartVisual; locale: string }>) {
  return (
    <div className="sr-only">
      <table>
        <caption>{visual.title}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {visual.series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visual.labels.map((label, i) => (
            <tr key={`${label}-${i}`}>
              <th scope="row">{label}</th>
              {visual.series.map((s) => (
                <td key={s.name}>{s.values[i] === null ? '' : formatNumber(s.values[i] as number, visual.format, locale)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
