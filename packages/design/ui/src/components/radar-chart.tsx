/**
 * Scores across several areas on a web: a spoke per area, rings at even
 * steps, and a shape per series, the main one filled in its colour with dots
 * on the spokes, a comparison (`dashed`) as a dashed grey outline. Pointing
 * at an area shows a card with every series' score there.
 *
 * A hidden table carries every score for assistive tech; the drawing is
 * hidden from it. The component holds no text of its own: area and series
 * names come in as props.
 */

import { useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { paletteColor } from '@weldsuite/ui/lib/chart-palette';
import { cn } from '@weldsuite/ui/lib/utils';

export interface RadarSeries {
  key: string;
  label: string;
  /** A score per area, in the order of `axes`. */
  values: number[];
  color?: string;
  /** Draws it as a comparison: a dashed outline, grey unless it has a colour. */
  dashed?: boolean;
}

export interface RadarChartProps {
  /** The areas, one spoke each, clockwise from twelve o'clock. */
  axes: string[];
  series: RadarSeries[];
  /** The outer ring's score; the highest score by default. */
  max?: number;
  /** How many rings; 4 by default. */
  rings?: number;
  formatValue?: (value: number) => string;
  /** A row under the chart naming the series; on when there is more than one. */
  legend?: boolean;
  caption?: string;
  /** Height and other sizing; `h-64` by default. */
  className?: string;
}

/** Room around the web for the area names. */
const LABEL_ROOM = 34;

export function RadarChart({ axes, series, max, rings = 4, formatValue = String, legend, caption, className }: Readonly<RadarChartProps>) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);
  const top = max ?? Math.max(0, ...series.flatMap((s) => s.values));
  const radius = Math.max(Math.min(width, height) / 2 - LABEL_ROOM, 0);
  const cx = width / 2;
  const cy = height / 2;
  const angle = (index: number) => (Math.PI * 2 * index) / Math.max(axes.length, 1) - Math.PI / 2;
  const point = (index: number, fraction: number) =>
    [cx + radius * fraction * Math.cos(angle(index)), cy + radius * fraction * Math.sin(angle(index))] as const;
  const fraction = (value: number) => (top > 0 ? Math.min(Math.max(value, 0) / top, 1) : 0);
  const colorOf = (s: RadarSeries, index: number) => s.color ?? (s.dashed ? 'var(--muted-foreground)' : paletteColor(index));
  // Comparisons first, so the main shapes sit on top.
  const drawOrder = series.map((s, index) => ({ s, index })).sort((a, b) => Number(b.s.dashed ?? false) - Number(a.s.dashed ?? false));
  const showLegend = legend ?? series.length > 1;

  return (
    <div className="grid gap-3">
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
            {axes.map((axis, a) => (
              <tr key={axis}>
                <th scope="row">{axis}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatValue(s.values[a] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {radius > 0 && axes.length >= 3 && (
          <div aria-hidden className="absolute inset-0">
            <svg width={width} height={height} className="absolute inset-0 overflow-visible">
              {Array.from({ length: rings }, (_, r) => (
                <polygon
                  key={r}
                  points={axes.map((_, a) => point(a, (r + 1) / rings).join(',')).join(' ')}
                  fill="none"
                  style={{ stroke: 'var(--border)' }}
                />
              ))}
              {axes.map((axis, a) => (
                <line
                  key={axis}
                  x1={cx}
                  y1={cy}
                  x2={point(a, 1)[0]}
                  y2={point(a, 1)[1]}
                  style={{ stroke: hovered === a ? 'var(--muted-foreground)' : 'var(--border)' }}
                />
              ))}
              {drawOrder.map(({ s, index }) => {
                const color = colorOf(s, index);
                const points = axes.map((_, a) => point(a, fraction(s.values[a] ?? 0)).join(',')).join(' ');
                return (
                  <g key={s.key}>
                    <polygon
                      points={points}
                      strokeWidth={s.dashed ? 1.5 : 2}
                      strokeLinejoin="round"
                      strokeDasharray={s.dashed ? '4 4' : undefined}
                      style={{ stroke: color, fill: s.dashed ? 'none' : color, fillOpacity: 0.15 }}
                    />
                    {!s.dashed &&
                      axes.map((axis, a) => {
                        const [x, y] = point(a, fraction(s.values[a] ?? 0));
                        return <circle key={axis} cx={x} cy={y} r={hovered === a ? 4 : 2.5} style={{ fill: color }} />;
                      })}
                  </g>
                );
              })}
              {axes.map((axis, a) => {
                // An invisible wedge per area, halfway to its neighbours, that catches the pointer.
                const half = Math.PI / axes.length;
                const reach = radius + LABEL_ROOM;
                const edge = (offset: number) => `${cx + reach * Math.cos(angle(a) + offset)},${cy + reach * Math.sin(angle(a) + offset)}`;
                return (
                  <polygon
                    key={axis}
                    points={`${cx},${cy} ${edge(-half)} ${edge(half)}`}
                    fill="transparent"
                    onPointerEnter={() => setHovered(a)}
                    onPointerLeave={() => setHovered(null)}
                  />
                );
              })}
            </svg>
            {axes.map((axis, a) => {
              const [x, y] = point(a, 1);
              const dx = Math.cos(angle(a));
              const dy = Math.sin(angle(a));
              return (
                <span
                  key={axis}
                  className={cn('pointer-events-none absolute text-xs whitespace-nowrap', hovered === a ? 'text-foreground' : 'text-muted-foreground')}
                  style={{
                    left: x + dx * 10,
                    top: y + dy * 10,
                    transform: `translate(${dx > 0.2 ? '0' : dx < -0.2 ? '-100%' : '-50%'}, ${dy > 0.2 ? '0' : dy < -0.2 ? '-100%' : '-50%'})`,
                  }}
                >
                  {axis}
                </span>
              );
            })}
            {hovered !== null && (
              <ChartHoverCard
                title={axes[hovered]}
                className="pointer-events-none absolute z-10 w-max"
                style={{
                  left: Math.min(Math.max(point(hovered, 0.5)[0] - 90, 0), Math.max(width - 180, 0)),
                  top: point(hovered, 0.5)[1] + (Math.sin(angle(hovered)) < 0 ? 12 : -84),
                }}
              >
                {series.map((s, index) => (
                  <ChartTooltipRow key={s.key} label={s.label} value={formatValue(s.values[hovered] ?? 0)} color={colorOf(s, index)} dashed={s.dashed} />
                ))}
              </ChartHoverCard>
            )}
          </div>
        )}
      </div>
      {showLegend && (
        <div aria-hidden className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s, index) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className={cn('w-3 border-t-2', s.dashed && 'border-dashed')} style={{ borderColor: colorOf(s, index) }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
