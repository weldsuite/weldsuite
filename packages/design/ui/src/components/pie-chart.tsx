/**
 * A pie or donut: a slice per part, split by thin gaps in the page colour,
 * with rows beside it (colour, name, amount and share) as in the dashboard's
 * breakdown lists. A donut can show the total, or anything else, in its
 * middle. Pointing at a slice or its row dims the other slices and, on the
 * slice, shows a card with the part's share and amount.
 *
 * The rows carry every figure for assistive tech (a hidden list when the rows
 * are turned off); the drawing is hidden from it. The component holds no text
 * of its own: names and amounts come in with the slices.
 */

import { useRef, useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { cardBeside, paletteColor, pointerIn } from '@weldsuite/ui/lib/chart-palette';
import { cn } from '@weldsuite/ui/lib/utils';

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  /** The amount as shown, such as "€14,450". */
  display: string;
  /** The slice's colour; the chart colours in turn by default. */
  color?: string;
}

export interface PieChartProps {
  slices: PieSlice[];
  /** A full pie (the default) or a ring. */
  variant?: 'pie' | 'donut';
  /** The donut's middle: a figure and, under it, a word or two. */
  center?: { value: string; label?: string };
  /** A 0-1 share as text; a whole percentage by default. */
  formatShare?: (share: number) => string;
  /** The rows beside the chart; on by default. */
  legend?: boolean;
  /** The chart's width and height in pixels; 160 by default. */
  size?: number;
  /** Names the rows for assistive tech. */
  label?: string;
  className?: string;
}

const R = 50;
const DONUT_INNER = 31;
const defaultShare = (share: number) => `${Math.round(share * 100)}%`;

const point = (radius: number, angle: number) => `${R + radius * Math.cos(angle)},${R + radius * Math.sin(angle)}`;

/** A slice from `from` to `to` (radians, 0 at three o'clock), in a 100 by 100 box. */
export function slicePath(from: number, to: number, inner: number): string {
  if (to - from >= Math.PI * 2 - 1e-6) {
    // A whole circle: two half arcs, and for a ring the hole cut out (even-odd).
    const ring = (radius: number) => `M${R - radius},${R} A${radius},${radius} 0 1 1 ${R + radius},${R} A${radius},${radius} 0 1 1 ${R - radius},${R} Z`;
    return inner > 0 ? `${ring(R)} ${ring(inner)}` : ring(R);
  }
  const large = to - from > Math.PI ? 1 : 0;
  if (inner <= 0) return `M${R},${R} L${point(R, from)} A${R},${R} 0 ${large} 1 ${point(R, to)} Z`;
  return `M${point(R, from)} A${R},${R} 0 ${large} 1 ${point(R, to)} L${point(inner, to)} A${inner},${inner} 0 ${large} 0 ${point(inner, from)} Z`;
}

export function PieChart({
  slices,
  variant = 'pie',
  center,
  formatShare = defaultShare,
  legend = true,
  size = 160,
  label,
  className,
}: Readonly<PieChartProps>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [card, setCard] = useState<{ left: number; top: number } | null>(null);
  const inner = variant === 'donut' ? DONUT_INNER : 0;
  const total = slices.reduce((sum, slice) => sum + Math.max(slice.value, 0), 0);
  const share = (slice: PieSlice) => (total > 0 ? Math.max(slice.value, 0) / total : 0);
  const colorOf = (index: number) => slices[index].color ?? paletteColor(index);

  let angle = -Math.PI / 2;
  const arcs = slices.map((slice, index) => {
    const from = angle;
    angle += share(slice) * Math.PI * 2;
    return { slice, index, from, to: angle };
  });
  const hoveredIndex = slices.findIndex((slice) => slice.key === hovered);

  const rows = slices.map((slice, index) => (
    <li
      key={slice.key}
      className={cn('flex items-center gap-2.5 py-2 text-sm transition-opacity', hovered && hovered !== slice.key && 'opacity-50')}
      onPointerEnter={() => setHovered(slice.key)}
      onPointerLeave={() => setHovered(null)}
    >
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: colorOf(index) }} />
      <span className="min-w-0 flex-1 truncate">{slice.label}</span>
      <span className="font-medium tabular-nums">{slice.display}</span>
      <span className="w-10 text-right text-muted-foreground tabular-nums">{formatShare(share(slice))}</span>
    </li>
  ));

  return (
    <div ref={boxRef} className={cn('relative flex flex-wrap items-center gap-x-8 gap-y-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg aria-hidden viewBox="0 0 100 100" className="size-full">
          {total > 0 ? (
            arcs
              .filter(({ slice }) => share(slice) > 0)
              .map(({ slice, index, from, to }) => (
                <path
                  key={slice.key}
                  d={slicePath(from, to, inner)}
                  fillRule="evenodd"
                  className="transition-opacity"
                  style={{ fill: colorOf(index), stroke: 'var(--background)', strokeWidth: 1, opacity: hovered && hovered !== slice.key ? 0.35 : 1 }}
                  onPointerEnter={() => setHovered(slice.key)}
                  onPointerMove={(event) => {
                    const at = pointerIn(boxRef.current, event);
                    if (at) setCard(cardBeside(at));
                  }}
                  onPointerLeave={() => {
                    setHovered(null);
                    setCard(null);
                  }}
                />
              ))
          ) : (
            <path d={slicePath(0, Math.PI * 2, inner)} fillRule="evenodd" style={{ fill: 'var(--muted)' }} />
          )}
        </svg>
        {variant === 'donut' && center && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-base font-medium tabular-nums">{center.value}</span>
            {center.label && <span className="text-xs text-muted-foreground">{center.label}</span>}
          </div>
        )}
      </div>
      {legend ? (
        <ul className="min-w-48 flex-1 divide-y" aria-label={label}>
          {rows}
        </ul>
      ) : (
        <ul className="sr-only" aria-label={label}>
          {rows}
        </ul>
      )}
      {card && hoveredIndex >= 0 && (
        <ChartHoverCard aria-hidden title={slices[hoveredIndex].label} className="pointer-events-none absolute z-10 w-max" style={card}>
          <ChartTooltipRow swatch="square" color={colorOf(hoveredIndex)} label={formatShare(share(slices[hoveredIndex]))} value={slices[hoveredIndex].display} />
        </ChartHoverCard>
      )}
    </div>
  );
}
