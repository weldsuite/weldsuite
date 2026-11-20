/**
 * Two measures per item, such as each open deal's value by its age: a dot
 * per item on light grid lines, with round y labels on the right and the x
 * axis' two ends named underneath, as the dashboard's charts draw them. A
 * third measure can size the dots. Pointing at a dot shows a card with its
 * measures.
 *
 * A hidden table carries every item for assistive tech; the drawing is hidden
 * from it. The component holds no text of its own: names, the measures'
 * labels and their formats come in as props.
 */

import { useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { labelGutter, linearScale, onPixelRow } from '@weldsuite/ui/lib/chart-axes';
import { tint } from '@weldsuite/ui/lib/chart-palette';
import { niceTicks } from '@weldsuite/ui/lib/nice-ticks';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ScatterPoint {
  key: string;
  label: string;
  x: number;
  y: number;
  /** Sizes the dot, when the chart has a third measure. */
  size?: number;
}

export interface ScatterChartProps {
  points: ScatterPoint[];
  /** What x and y (and size) are, in the card: "Age", "Value", "Probability". */
  xLabel: string;
  yLabel: string;
  sizeLabel?: string;
  formatX?: (value: number) => string;
  formatY?: (value: number) => string;
  formatSize?: (value: number) => string;
  /** The dots' colour; `--chart-1` by default. */
  color?: string;
  caption?: string;
  /** Height and other sizing; `h-64` by default. */
  className?: string;
}

/** Room under the plot for the x axis' end names. */
const X_LABELS = 22;
const TOP = 8;
const DOT = { min: 4, max: 12, plain: 5 };

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  sizeLabel,
  formatX = String,
  formatY = String,
  formatSize = String,
  color = 'var(--chart-1)',
  caption,
  className,
}: Readonly<ScatterChartProps>) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);
  const yTicks = niceTicks(Math.min(0, ...points.map((p) => p.y)), Math.max(0, ...points.map((p) => p.y)));
  const xTicks = niceTicks(Math.min(0, ...points.map((p) => p.x)), Math.max(0, ...points.map((p) => p.x)));
  const yLabels = yTicks.map((tick) => formatY(tick));
  const plotWidth = Math.max(width - labelGutter(yLabels), 0);
  const plotBottom = Math.max(height - X_LABELS, TOP);
  const xDomain = [xTicks[0], xTicks[xTicks.length - 1] || 1] as const;
  const yDomain = [yTicks[0], yTicks[yTicks.length - 1] || 1] as const;
  const x = linearScale(xDomain, [DOT.max, plotWidth - DOT.max]);
  const y = linearScale(yDomain, [plotBottom, TOP]);
  const largest = Math.max(0, ...points.map((p) => p.size ?? 0));
  const radius = (point: ScatterPoint) =>
    point.size === undefined || largest <= 0 ? DOT.plain : DOT.min + (DOT.max - DOT.min) * Math.sqrt(Math.max(point.size, 0) / largest);
  const active = points.find((point) => point.key === hovered);

  return (
    <div ref={ref} className={cn('relative h-64 w-full', className)}>
      <table className="sr-only">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            <td />
            <th scope="col">{xLabel}</th>
            <th scope="col">{yLabel}</th>
            {sizeLabel && <th scope="col">{sizeLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}>
              <th scope="row">{point.label}</th>
              <td>{formatX(point.x)}</td>
              <td>{formatY(point.y)}</td>
              {sizeLabel && <td>{point.size === undefined ? '' : formatSize(point.size)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {plotWidth > 0 && (
        <div aria-hidden className="absolute inset-0">
          <svg width={width} height={height} className="absolute inset-0">
            {yTicks.map((tick) => (
              <line key={tick} x1={0} x2={plotWidth} y1={onPixelRow(y(tick))} y2={onPixelRow(y(tick))} style={{ stroke: 'var(--border)' }} />
            ))}
            {[...points]
              .sort((a, b) => radius(b) - radius(a))
              .map((point) => (
                <circle
                  key={point.key}
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={radius(point)}
                  strokeWidth={hovered === point.key ? 2 : 1}
                  className="transition-[fill]"
                  style={{ fill: tint(color, hovered === point.key ? 60 : 35), stroke: color }}
                  onPointerEnter={() => setHovered(point.key)}
                  onPointerLeave={() => setHovered(null)}
                />
              ))}
          </svg>
          {yTicks.map((tick, i) => (
            <span key={tick} className="absolute text-xs text-muted-foreground tabular-nums" style={{ left: plotWidth + 8, top: y(tick), transform: 'translateY(-50%)' }}>
              {yLabels[i]}
            </span>
          ))}
          <span className="absolute left-0 text-xs text-muted-foreground tabular-nums" style={{ top: plotBottom + 6 }}>
            {formatX(xDomain[0])}
          </span>
          <span className="absolute text-xs text-muted-foreground tabular-nums" style={{ top: plotBottom + 6, right: width - plotWidth }}>
            {formatX(xDomain[1])}
          </span>
          {active && (
            <ChartHoverCard
              title={active.label}
              className="pointer-events-none absolute z-10 w-max"
              style={{
                left: x(active.x) + 14 + 180 > width ? Math.max(x(active.x) - 14 - 180, 0) : x(active.x) + 14,
                top: Math.min(y(active.y) + 10, Math.max(height - 96, 0)),
              }}
            >
              <ChartTooltipRow swatch="none" label={xLabel} value={formatX(active.x)} />
              <ChartTooltipRow swatch="none" label={yLabel} value={formatY(active.y)} />
              {sizeLabel && active.size !== undefined && <ChartTooltipRow swatch="none" label={sizeLabel} value={formatSize(active.size)} />}
            </ChartHoverCard>
          )}
        </div>
      )}
    </div>
  );
}
