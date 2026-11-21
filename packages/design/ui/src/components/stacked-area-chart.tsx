/**
 * Parts of a total over time: a band per series stacked on the ones below,
 * each a flat tint of its colour with a 2px line on top, on light grid lines
 * with round y labels on the right and the first and last period named
 * underneath, as the dashboard's charts draw them. `normalize` shows each
 * period's parts as shares of its total instead. Pointing at the chart marks
 * the nearest period and shows a card with every series there and the total.
 *
 * A hidden table carries every figure for assistive tech; the drawing is
 * hidden from it. The component holds no text of its own: names and the
 * formats come in as props.
 */

import { useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { labelGutter, linearScale, onPixelRow } from '@weldsuite/ui/lib/chart-axes';
import { cardBeside, paletteColor, tint } from '@weldsuite/ui/lib/chart-palette';
import { niceTicks } from '@weldsuite/ui/lib/nice-ticks';
import { cn } from '@weldsuite/ui/lib/utils';

export interface StackedAreaSeries {
  key: string;
  label: string;
  /** A figure per period, in the order of `periods`; missing ones count as zero. */
  values: number[];
  color?: string;
}

export interface StackedAreaChartProps {
  /** The periods' keys, such as `2026-10`; the formatters turn them into text. */
  periods: string[];
  /** Bottom to top. */
  series: StackedAreaSeries[];
  /** A period's name under the x axis' ends: "Dec 2025". */
  formatTick: (period: string) => string;
  /** A period's name in the card: "December 2025". */
  formatPeriod?: (period: string) => string;
  /** A y label (short, "€30K") and a figure in the card. Shares 0-1 when `normalize`. */
  formatAxisValue?: (value: number) => string;
  formatValue?: (value: number) => string;
  /** Each period's parts as shares of its total, so the chart fills to the top. */
  normalize?: boolean;
  /** Adds a total row to the card, with this label. */
  totalLabel?: string;
  caption?: string;
  /** Height and other sizing; `h-64` by default. */
  className?: string;
}

const X_LABELS = 22;
const TOP = 8;
const percent = (share: number) => `${Math.round(share * 100)}%`;

export function StackedAreaChart({
  periods,
  series,
  formatTick,
  formatPeriod = formatTick,
  formatAxisValue,
  formatValue,
  normalize = false,
  totalLabel,
  caption,
  className,
}: Readonly<StackedAreaChartProps>) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<{ index: number; left: number; top: number } | null>(null);
  const axisFormat = formatAxisValue ?? (normalize ? percent : String);
  const valueFormat = formatValue ?? (normalize ? percent : String);
  const raw = series.map((s) => periods.map((_, i) => Math.max(s.values[i] ?? 0, 0)));
  const totals = periods.map((_, i) => raw.reduce((sum, values) => sum + values[i], 0));
  const shown = normalize ? raw.map((values) => values.map((v, i) => (totals[i] > 0 ? v / totals[i] : 0))) : raw;
  // Each series' top edge per period: the running sum from the bottom.
  const tops: number[][] = [];
  shown.forEach((values, s) => tops.push(values.map((v, i) => v + (s > 0 ? tops[s - 1][i] : 0))));
  const highest = normalize ? 1 : Math.max(0, ...(tops[tops.length - 1] ?? [0]));
  const ticks = normalize ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, highest);
  const tickLabels = ticks.map((tick) => axisFormat(tick));
  const plotWidth = Math.max(width - labelGutter(tickLabels), 0);
  const plotBottom = Math.max(height - X_LABELS, TOP);
  const x = linearScale([0, Math.max(periods.length - 1, 1)], [0, plotWidth]);
  const y = linearScale([0, ticks[ticks.length - 1] || 1], [plotBottom, TOP]);
  const colorOf = (index: number) => series[index].color ?? paletteColor(index);
  const line = (values: number[]) => values.map((v, i) => `${x(i)},${y(v)}`).join(' ');

  return (
    <div ref={ref} className={cn('relative h-64 w-full', className)}>
      <table className="sr-only">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            <td />
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((period, i) => (
            <tr key={period}>
              <th scope="row">{formatPeriod(period)}</th>
              {series.map((s, si) => (
                <td key={s.key}>{valueFormat(shown[si][i])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {plotWidth > 0 && periods.length > 0 && (
        <div aria-hidden className="absolute inset-0">
          <svg
            width={width}
            height={height}
            className="absolute inset-0"
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const px = event.clientX - box.left;
              const index = Math.round(((px / Math.max(plotWidth, 1)) * (periods.length - 1)) || 0);
              const clamped = Math.min(Math.max(index, 0), periods.length - 1);
              const at = cardBeside({ x: px, y: event.clientY - box.top, width });
              setHovered({ index: clamped, left: at.left, top: Math.min(TOP + 4, at.top) });
            }}
            onPointerLeave={() => setHovered(null)}
          >
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={plotWidth} y1={onPixelRow(y(tick))} y2={onPixelRow(y(tick))} style={{ stroke: 'var(--border)' }} />
            ))}
            {tops.map((top, s) => {
              const bottom = s > 0 ? tops[s - 1] : top.map(() => 0);
              const area = `M${line(top)} L${bottom
                .map((v, i) => `${x(i)},${y(v)}`)
                .reverse()
                .join(' L')} Z`;
              return <path key={series[s].key} d={area} style={{ fill: tint(colorOf(s), 22) }} />;
            })}
            {tops.map((top, s) => (
              <polyline key={series[s].key} points={line(top)} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: colorOf(s) }} />
            ))}
            {hovered && (
              <>
                <line x1={x(hovered.index)} x2={x(hovered.index)} y1={TOP} y2={plotBottom} style={{ stroke: 'var(--border)' }} />
                {tops.map((top, s) => (
                  <circle key={series[s].key} cx={x(hovered.index)} cy={y(top[hovered.index])} r={3.5} strokeWidth={2} style={{ fill: colorOf(s), stroke: 'var(--background)' }} />
                ))}
              </>
            )}
          </svg>
          {ticks.map((tick, i) => (
            <span key={tick} className="absolute text-xs text-muted-foreground tabular-nums" style={{ left: plotWidth + 8, top: y(tick), transform: 'translateY(-50%)' }}>
              {tickLabels[i]}
            </span>
          ))}
          <span className="absolute left-0 text-xs text-muted-foreground tabular-nums" style={{ top: plotBottom + 6 }}>
            {formatTick(periods[0])}
          </span>
          {periods.length > 1 && (
            <span className="absolute text-xs text-muted-foreground tabular-nums" style={{ top: plotBottom + 6, right: width - plotWidth }}>
              {formatTick(periods[periods.length - 1])}
            </span>
          )}
          {hovered && (
            <ChartHoverCard title={formatPeriod(periods[hovered.index])} className="pointer-events-none absolute z-10 w-max" style={{ left: hovered.left, top: hovered.top }}>
              {[...series].reverse().map((s, r) => {
                const index = series.length - 1 - r;
                return <ChartTooltipRow key={s.key} swatch="square" color={colorOf(index)} label={s.label} value={valueFormat(shown[index][hovered.index])} />;
              })}
              {totalLabel && <ChartTooltipRow swatch="none" label={totalLabel} value={valueFormat(normalize ? 1 : totals[hovered.index])} />}
            </ChartHoverCard>
          )}
        </div>
      )}
    </div>
  );
}
