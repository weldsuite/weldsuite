/**
 * Several goals as rings, like an activity tracker: a ring per item, outside
 * in, on a grey track, filled clockwise from twelve o'clock to the item's
 * share of its target, with rows beside it (colour, name, amount and share).
 * Pointing at a ring or its row dims the others and shows that item's share
 * in the middle.
 *
 * Each row is an ARIA meter; the drawing is hidden from assistive tech. The
 * component holds no text of its own: names and amounts come in with the
 * items.
 */

import { useState } from 'react';
import { paletteColor } from '@weldsuite/ui/lib/chart-palette';
import { cn } from '@weldsuite/ui/lib/utils';

export interface RadialBarsItem {
  key: string;
  label: string;
  value: number;
  /** What a full ring is: the target, the limit. */
  max: number;
  /** The amount as shown, such as "€82,000". */
  display: string;
  color?: string;
}

export interface RadialBarsProps {
  items: RadialBarsItem[];
  /** A share of the target as text (can be over 1); a whole percentage by default. */
  formatShare?: (share: number) => string;
  /** The rows beside the rings; on by default. */
  legend?: boolean;
  /** The rings' width and height in pixels; 160 by default. */
  size?: number;
  className?: string;
}

const OUTER = 56;
const INNER = 16;
const defaultShare = (share: number) => `${Math.round(share * 100)}%`;

export function RadialBars({ items, formatShare = defaultShare, legend = true, size = 160, className }: Readonly<RadialBarsProps>) {
  const [hovered, setHovered] = useState<string | null>(null);
  const band = items.length > 0 ? (OUTER - INNER) / items.length : 0;
  const stroke = Math.min(band * 0.72, 12);
  const share = (item: RadialBarsItem) => {
    if (item.max > 0) return Math.max(item.value, 0) / item.max;
    return item.value > 0 ? 1 : 0;
  };
  const colorOf = (index: number) => items[index].color ?? paletteColor(index);
  const active = items.find((item) => item.key === hovered);

  return (
    <div className={cn('flex flex-wrap items-center gap-x-8 gap-y-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg aria-hidden viewBox="0 0 120 120" className="size-full -rotate-90">
          {items.map((item, index) => {
            const radius = OUTER - band * index - stroke / 2;
            const circumference = 2 * Math.PI * radius;
            const filled = Math.min(share(item), 1) * circumference;
            return (
              <g
                key={item.key}
                className="transition-opacity"
                style={{ opacity: hovered && hovered !== item.key ? 0.35 : 1 }}
                onPointerEnter={() => setHovered(item.key)}
                onPointerLeave={() => setHovered(null)}
              >
                <circle cx={60} cy={60} r={radius} fill="none" strokeWidth={stroke} style={{ stroke: 'var(--muted)' }} />
                {filled > 0 && (
                  <circle
                    cx={60}
                    cy={60}
                    r={radius}
                    fill="none"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={`${filled} ${circumference}`}
                    className="transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
                    style={{ stroke: colorOf(index) }}
                  />
                )}
              </g>
            );
          })}
        </svg>
        {active && (
          <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-base font-medium tabular-nums">{formatShare(share(active))}</span>
          </div>
        )}
      </div>
      <ul className={legend ? 'min-w-48 flex-1 divide-y' : 'sr-only'}>
        {items.map((item, index) => (
          <li
            key={item.key}
            role="meter"
            aria-label={item.label}
            aria-valuemin={0}
            aria-valuemax={item.max}
            aria-valuenow={item.value}
            aria-valuetext={`${item.display}, ${formatShare(share(item))}`}
            className={cn('flex items-center gap-2.5 py-2 text-sm transition-opacity', hovered && hovered !== item.key && 'opacity-50')}
            onPointerEnter={() => setHovered(item.key)}
            onPointerLeave={() => setHovered(null)}
          >
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: colorOf(index) }} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="text-muted-foreground tabular-nums">{item.display}</span>
            <span className="w-11 text-right font-medium tabular-nums">{formatShare(share(item))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
