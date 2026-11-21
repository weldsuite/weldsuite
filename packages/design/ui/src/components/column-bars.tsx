/**
 * A small column chart, one bar per period, as on a realtime overview's
 * "per minute" strip: thin bars from the bottom, light gridlines with their
 * values on the right, and labels under the bars that carry an `axisLabel`
 * (every fifth minute, say). Under the pointer a column shows a card with its
 * label and value. An empty chart still shows its grid, 0 to 1.
 *
 * Screen readers get the periods as a table. The component holds no text of
 * its own: labels and formatted values come in with the items.
 */

import { useRef, useState, type PointerEvent } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { cardBeside, pointerIn, tint } from '@weldsuite/ui/lib/chart-palette';
import { niceTicks } from '@weldsuite/ui/lib/nice-ticks';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ColumnBarsItem {
  key: string;
  /** The period, for the hover card and the table ("2 minutes ago"). */
  label: string;
  value: number;
  /** The value as shown. */
  display: string;
  /** Shown under the bar, such as "-25 min"; leave it out for most bars. */
  axisLabel?: string;
}

export interface ColumnBarsProps {
  items: ColumnBarsItem[];
  /** What the value is ("Active visitors"): the hover card's row and the table's column. */
  valueLabel: string;
  /** The table's first column ("Minute"). */
  periodLabel: string;
  /** Names the chart for assistive tech. */
  label?: string;
  /** The bars' colour; `--chart-1` by default. */
  color?: string;
  /** The bars' area in pixels, without the labels under it. */
  height?: number;
  /** The gridline values on the right; the plain number by default. */
  formatAxis?: (value: number) => string;
  className?: string;
}

interface Hover {
  index: number;
  left: number;
  top: number;
}

/** The gridlines: round values from 0 up to at least 1; whole numbers only when every value is whole. */
export function columnTicks(values: readonly number[]): number[] {
  const top = Math.max(1, ...values);
  const ticks = niceTicks(0, top);
  if (!values.every(Number.isInteger)) return ticks;
  const whole = ticks.filter(Number.isInteger);
  return whole.length >= 2 ? whole : [0, Math.ceil(top)];
}

export function ColumnBars({
  items,
  valueLabel,
  periodLabel,
  label,
  color = 'var(--chart-1)',
  height = 72,
  formatAxis = String,
  className,
}: Readonly<ColumnBarsProps>) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const ticks = columnTicks(items.map((item) => item.value));
  const top = ticks.at(-1) ?? 1;
  const active = hover ? items[hover.index] : undefined;

  const point = (index: number) => (event: PointerEvent) => {
    const pointer = pointerIn(ref.current, event);
    if (pointer) setHover({ index, ...cardBeside(pointer) });
  };

  return (
    <div ref={ref} className={cn('relative', className)} onPointerLeave={() => setHover(null)}>
      <div className="relative pr-8" style={{ height }} role="img" aria-label={label}>
        {ticks.map((tick) => (
          <div key={tick} aria-hidden className="absolute inset-x-0 flex h-0 items-center" style={{ bottom: `${(tick / top) * 100}%` }}>
            <span className="flex-1 border-t border-border/70" />
            <span className="w-8 pl-2 text-[10px] leading-none text-muted-foreground tabular-nums">{formatAxis(tick)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 left-0 right-8 flex items-end gap-[3px]">
          {items.map((item, index) => (
            <div key={item.key} className="flex h-full min-w-0 flex-1 items-end" onPointerMove={point(index)}>
              <div
                className="w-full rounded-t-[2px] transition-[height] duration-300 motion-reduce:transition-none"
                style={{
                  height: `${(Math.max(item.value, 0) / top) * 100}%`,
                  backgroundColor: hover && hover.index !== index ? tint(color, 55) : color,
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div aria-hidden className="mt-1.5 flex gap-[3px] pr-8">
        {items.map((item) => (
          <div key={item.key} className="relative h-3 min-w-0 flex-1">
            {item.axisLabel && (
              <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-muted-foreground">{item.axisLabel}</span>
            )}
          </div>
        ))}
      </div>

      {active && hover && (
        <ChartHoverCard title={active.label} className="pointer-events-none absolute z-10" style={{ left: hover.left, top: hover.top }}>
          <ChartTooltipRow label={valueLabel} value={active.display} color={color} swatch="square" />
        </ChartHoverCard>
      )}

      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">{periodLabel}</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key}>
              <th scope="row">{item.label}</th>
              <td>{item.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
