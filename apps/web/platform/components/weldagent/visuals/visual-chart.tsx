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

type Format = (value: number, compact?: boolean) => string;

/** The library chart's config: one entry per series (`s0`, `s1`, …), or the value of a pie. */
function chartConfig(visual: ChartVisual): ChartConfig {
  if (visual.kind === 'pie' || visual.kind === 'donut') {
    return { value: { label: visual.series[0]?.name ?? visual.title } };
  }
  return Object.fromEntries(visual.series.map((s, i) => [`s${i}`, { label: s.name, color: seriesColor(i) }]));
}

/** The tooltip: a swatch, the series (or slice) name and the value as the spec formats it. */
function valueTooltip(config: ChartConfig, format: Format) {
  return (
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
}

interface ChartPartProps {
  visual: ChartVisual;
  config: ChartConfig;
  format: Format;
  /** Tailwind classes for the chart box (height, cursor). */
  boxClass: string;
  /** A label (by index) was clicked; absent when the chat cannot ask. */
  pickIndex?: (index: number) => void;
  surfaceRef?: Ref<HTMLDivElement>;
}

function PieVisual({ visual, config, format, boxClass, pickIndex, surfaceRef, otherLabel }: Readonly<ChartPartProps & { otherLabel: string }>) {
  const slices = toSlices(visual, otherLabel);
  const onSliceClick = pickIndex
    ? (_: unknown, index: number) => {
        const slice = slices[index];
        if (slice && slice.index >= 0) pickIndex(slice.index);
      }
    : undefined;
  return (
    <div ref={surfaceRef}>
      <ChartContainer config={config} className={boxClass}>
        <PieChart>
          {valueTooltip(config, format)}
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius={visual.kind === 'donut' ? '55%' : 0}
            outerRadius="85%"
            strokeWidth={2}
            stroke="var(--background)"
            isAnimationActive={false}
            onClick={onSliceClick}
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

const MARGIN = { left: 0, right: 8, top: 8, bottom: 0 };

/** The bars of every series; stacked bars have square corners so the stack reads as one. */
function bars(visual: ChartVisual, horizontal: boolean) {
  const stackId = visual.stacked ? 'stack' : undefined;
  const rounded: [number, number, number, number] = horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0];
  return visual.series.map((s, i) => (
    <Bar
      key={`${s.name}-${i}`}
      dataKey={`s${i}`}
      stackId={stackId}
      fill={`var(--color-s${i})`}
      radius={stackId ? 0 : rounded}
      isAnimationActive={false}
    />
  ));
}

function CartesianVisual({ visual, config, format, boxClass, pickIndex, surfaceRef }: Readonly<ChartPartProps>) {
  const rows = useMemo(() => toRows(visual), [visual]);
  const onClick = pickIndex
    ? (state: MouseHandlerDataParam) => pickIndex(Number(state.activeTooltipIndex))
    : undefined;
  const shared = (
    <>
      {valueTooltip(config, format)}
      {visual.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
    </>
  );
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
      <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => format(v, true)} />
    </>
  );

  let chart;
  if (visual.kind === 'bar' && visual.horizontal) {
    chart = (
      <BarChart data={rows} layout="vertical" margin={MARGIN} onClick={onClick}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => format(v, true)} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={96} />
        {shared}
        {bars(visual, true)}
      </BarChart>
    );
  } else if (visual.kind === 'bar') {
    chart = (
      <BarChart data={rows} margin={MARGIN} onClick={onClick}>
        {axes}
        {shared}
        {bars(visual, false)}
      </BarChart>
    );
  } else if (visual.kind === 'area') {
    chart = (
      <AreaChart data={rows} margin={MARGIN} onClick={onClick}>
        {axes}
        {shared}
        {visual.series.map((s, i) => (
          <Area
            key={`${s.name}-${i}`}
            dataKey={`s${i}`}
            type="monotone"
            stackId={visual.stacked ? 'stack' : undefined}
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
      <LineChart data={rows} margin={MARGIN} onClick={onClick}>
        {axes}
        {shared}
        {visual.series.map((s, i) => (
          <Line
            key={`${s.name}-${i}`}
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
      <ChartContainer config={config} className={boxClass}>
        {chart}
      </ChartContainer>
    </div>
  );
}

export function VisualChart({ visual, locale, expanded = false, onPick, surfaceRef, otherLabel }: Readonly<VisualChartProps>) {
  const config = useMemo(() => chartConfig(visual), [visual]);
  const format: Format = (value, compact = false) => formatNumber(value, visual.format, locale, { compact });
  const boxClass = cn('aspect-auto w-full', expanded ? 'h-[min(60vh,420px)]' : 'h-56', onPick && 'cursor-pointer');
  // A click picks a label; with one series (or a slice) its value comes along.
  const pickIndex = onPick
    ? (index: number) => {
        if (!Number.isInteger(index) || index < 0 || index >= visual.labels.length) return;
        const value = visual.series.length === 1 ? visual.series[0].values[index] : null;
        onPick({ label: visual.labels[index], ...(typeof value === 'number' ? { value } : {}) });
      }
    : undefined;
  const props = { visual, config, format, boxClass, pickIndex, surfaceRef };
  if (visual.kind === 'pie' || visual.kind === 'donut') return <PieVisual {...props} otherLabel={otherLabel} />;
  return <CartesianVisual {...props} />;
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
