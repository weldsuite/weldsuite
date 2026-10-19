/**
 * The line chart of Stripe's dashboard, on the shadcn chart container: the
 * period as a solid 2px line, the comparison as a dashed grey one, straight
 * segments (no smoothing, no area fill) and only the first and last x label,
 * pinned to the chart's edges.
 *
 * - `hero` is the "Today" chart: no y axis and no grid, just the baseline.
 * - `card` is an overview card chart: light horizontal grid lines with the
 *   y labels on the right, at round values (€0, €10K, €20K, €30K).
 *
 * A point without a value is a gap, so a running total stops at "now".
 *
 * A user's own overview chart can also draw the period as an `area` (the line
 * over a soft fill) or as `bar`s (the comparison as grey bars beside them), in
 * one of the theme's chart colours.
 */

import { useId, useMemo } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { niceTicks, type SeriesPoint } from './dashboard-series';
import { FOLLOWING_TOOLTIP_PROPS, FollowingTooltip } from './following-tooltip';
import { MoneyTooltipRow } from './money-tooltip-row';
import { useChartFormat } from './use-chart-format';

export const CURRENT_COLOR = 'var(--chart-1)';
export const COMPARISON_COLOR = 'var(--muted-foreground)';
/** Both axes' labels: the page's caption style (muted, 12px), digits of one width so the y labels line up. */
const AXIS_LABEL = 'fill-muted-foreground text-xs tabular-nums';
/**
 * A 1px rule's y, moved to the middle of a pixel row. Centred anywhere else a
 * 1px stroke is anti-aliased over two rows: on a whole y (8, 220) as two dim
 * rows, on y = 78.67 as one brighter row, so the grid lines looked unequal.
 * Centred on a row (7.5, 78.5) each fills exactly one row (two at 2x).
 * `shape-rendering: crispEdges` does not change this in Chrome.
 */
const onPixelRow = (y: number) => Math.round(y - 0.5) + 0.5;
/** Recharts' tick size (6) and our tick margin (8) between the plot and a y label, plus 2px of slack. */
const Y_LABEL_OFFSET = 16;

/**
 * The widest of `labels` at the axis labels' 12px in the page's font, so the
 * y-axis gutter fits "€30K" as well as "€ 1,5 mln." or "30.000 €". Recharts'
 * `width="auto"` does not measure custom tick elements.
 */
function useTextWidth(labels: string[]): number {
  const key = labels.join('\n');
  return useMemo(() => {
    const texts = key.split('\n');
    const context = document.createElement('canvas').getContext('2d');
    // Tabular digits run a little wider than the canvas measures; without a canvas, estimate per character.
    if (!context) return Math.max(0, ...texts.map((text) => text.length * 7.5));
    context.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    return Math.ceil(Math.max(0, ...texts.map((text) => context.measureText(text).width * 1.1)));
  }, [key]);
}

type Props = Readonly<{
  points: SeriesPoint[];
  variant: 'hero' | 'card';
  label: string;
  compareLabel: string;
  /** The text under each x end, from a `YYYY-MM` key. */
  formatTick: (month: string) => string;
  className?: string;
  /** How the period draws; `line` by default. */
  shape?: 'line' | 'area' | 'bar';
  /** The period's colour; the dashboard's chart colour by default. */
  color?: string;
}>;

export function ComparisonLineChart({
  points,
  variant,
  label,
  compareLabel,
  formatTick,
  className,
  shape = 'line',
  color = CURRENT_COLOR,
}: Props) {
  const format = useChartFormat();
  const fillId = `fill-${useId().replace(/:/g, '')}`;
  const config = {
    value: { label, color },
    compareValue: { label: compareLabel, color: COMPARISON_COLOR },
  } satisfies ChartConfig;
  const first = points[0]?.month;
  const last = points[points.length - 1]?.month;
  const hasComparison = points.some((p) => p.compareValue !== undefined);
  const card = variant === 'card';
  const values = points.flatMap((p) => [p.value ?? 0, p.compareValue ?? 0]);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const yLabelWidth = useTextWidth(ticks.map((t) => format.compactMoney(t)));
  const domainMin = ticks[0];
  const domainMax = ticks[ticks.length - 1] || 1;

  // The card's lines at its ticks, the hero's single baseline under the plot; each on a pixel row.
  const gridLines = ({ offset }: { offset: { top?: number; height?: number } }) => {
    const top = offset.top ?? 0;
    const height = offset.height ?? 0;
    if (!card) return [onPixelRow(top + height)];
    return ticks.map((t) => onPixelRow(top + (height * (domainMax - t)) / (domainMax - domainMin)));
  };

  return (
    <ChartContainer config={config} className={className}>
      <ComposedChart accessibilityLayer data={points} margin={{ top: 8, left: 0, right: 0, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={false} stroke="var(--border)" horizontalCoordinatesGenerator={gridLines} />
        <YAxis
          hide={!card}
          orientation="right"
          width={card ? yLabelWidth + Y_LABEL_OFFSET : 0}
          ticks={card ? ticks : undefined}
          interval={0}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={({ x, y, payload }: { x: number; y: number; payload: { value: number } }) => (
            <text x={x} y={y} dy="0.355em" textAnchor="start" className={AXIS_LABEL}>
              {format.compactMoney(payload.value)}
            </text>
          )}
          domain={
            card ? [domainMin, domainMax] : [(min: number) => Math.min(0, min), (max: number) => (max > 0 ? max : 1)]
          }
        />
        <XAxis
          dataKey="month"
          ticks={first && last ? [first, last] : []}
          interval={0}
          tickLine={false}
          // The hero's baseline is a grid line, so it sits on a pixel row like the card's.
          axisLine={false}
          tick={({ x, y, payload, index }: { x: number; y: number; payload: { value: string }; index: number }) => (
            <text x={x} y={y + 14} textAnchor={index === 0 ? 'start' : 'end'} className={AXIS_LABEL}>
              {formatTick(payload.value)}
            </text>
          )}
        />
        <ChartTooltip
          {...FOLLOWING_TOOLTIP_PROPS}
          cursor={shape === 'bar' ? { fill: 'var(--muted)', opacity: 0.6 } : { stroke: 'var(--border)' }}
          content={(props) => (
            <FollowingTooltip active={props.active} coordinate={props.coordinate}>
              <ChartTooltipContent
                active={props.active}
                // The dashed line is drawn first so it sits under the solid one; list the period first anyway.
                // (Recharts' `itemSorter` only applies to its own default content.)
                payload={[...(props.payload ?? [])].sort((a, b) => Number(b.dataKey === 'value') - Number(a.dataKey === 'value'))}
                hideLabel
                formatter={(value, name, item) => {
                  const point = item.payload as SeriesPoint;
                  const isCurrent = name === 'value';
                  return (
                    <MoneyTooltipRow
                      label={format.monthLong((isCurrent ? point.month : point.compareMonth) ?? '')}
                      color={isCurrent ? color : COMPARISON_COLOR}
                      dashed={!isCurrent}
                      value={format.formatMoney(Number(value))}
                    />
                  );
                }}
              />
            </FollowingTooltip>
          )}
        />
        {shape === 'area' && (
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
        )}
        {hasComparison && shape === 'bar' && (
          <Bar dataKey="compareValue" fill="var(--color-compareValue)" fillOpacity={0.35} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        )}
        {shape === 'bar' && (
          <Bar dataKey="value" fill="var(--color-value)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        )}
        {hasComparison && shape !== 'bar' && (
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
        {shape === 'area' && (
          <Area
            dataKey="value"
            type="linear"
            stroke="var(--color-value)"
            strokeWidth={2}
            fill={`url(#${fillId})`}
            dot={false}
            activeDot={{ r: 4, fill: color, stroke: 'var(--background)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        )}
        {shape === 'line' && (
          <Line
            dataKey="value"
            type="linear"
            stroke="var(--color-value)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: color, stroke: 'var(--background)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  );
}
