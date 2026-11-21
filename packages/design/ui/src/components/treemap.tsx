/**
 * Many parts of a whole as blocks, each sized by its share (squarified, so
 * the blocks stay close to square), tinted in its colour, with its name and
 * amount inside when they fit. Pointing at a block shows a card with its
 * share and amount.
 *
 * A hidden list carries every part for assistive tech; the blocks are hidden
 * from it. The component holds no text of its own: names and amounts come in
 * with the items.
 */

import { useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { cardBeside, paletteColor, pointerIn, tint } from '@weldsuite/ui/lib/chart-palette';
import { cn } from '@weldsuite/ui/lib/utils';

export interface TreemapItem {
  key: string;
  label: string;
  value: number;
  /** The amount as shown, such as "€18,200". */
  display: string;
  color?: string;
}

export interface TreemapProps {
  items: TreemapItem[];
  /** A 0-1 share as text; a whole percentage by default. */
  formatShare?: (share: number) => string;
  /** Names the list for assistive tech. */
  label?: string;
  /** Height and other sizing; `h-60` by default. */
  className?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const defaultShare = (share: number) => `${Math.round(share * 100)}%`;
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** How far from square the worst block in a row along `side` would be. */
function worst(row: readonly number[], side: number): number {
  const total = sum(row);
  const largest = Math.max(...row);
  const smallest = Math.min(...row);
  return Math.max((side * side * largest) / (total * total), (total * total) / (side * side * smallest));
}

/**
 * The squarified treemap layout (Bruls, Huizing and van Wijk): `values`,
 * biggest first and all above zero, as boxes filling `area`, laid in rows
 * along its shorter side while that keeps them closer to square.
 */
export function squarify(values: readonly number[], area: Box): Box[] {
  const total = sum(values);
  if (total <= 0 || area.w <= 0 || area.h <= 0) return values.map(() => ({ x: area.x, y: area.y, w: 0, h: 0 }));
  const scale = (area.w * area.h) / total;
  const areas = values.map((value) => value * scale);
  const boxes: Box[] = [];
  let rest = { ...area };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(rest.w, rest.h);
    const row = [areas[i]];
    while (i + row.length < areas.length && worst([...row, areas[i + row.length]], side) <= worst(row, side)) row.push(areas[i + row.length]);
    const rowTotal = sum(row);
    if (rest.w >= rest.h) {
      const columnWidth = rowTotal / rest.h;
      let y = rest.y;
      for (const a of row) {
        boxes.push({ x: rest.x, y, w: columnWidth, h: a / columnWidth });
        y += a / columnWidth;
      }
      rest = { x: rest.x + columnWidth, y: rest.y, w: rest.w - columnWidth, h: rest.h };
    } else {
      const rowHeight = rowTotal / rest.w;
      let x = rest.x;
      for (const a of row) {
        boxes.push({ x, y: rest.y, w: a / rowHeight, h: rowHeight });
        x += a / rowHeight;
      }
      rest = { x: rest.x, y: rest.y + rowHeight, w: rest.w, h: rest.h - rowHeight };
    }
    i += row.length;
  }
  return boxes;
}

/** Blocks smaller than this show no text. */
const TEXT_MIN = { w: 72, h: 40 };
const GAP = 2;

export function Treemap({ items, formatShare = defaultShare, label, className }: Readonly<TreemapProps>) {
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);
  const [card, setCard] = useState<{ left: number; top: number } | null>(null);
  const shown = items
    .map((item, index) => ({ item, color: item.color ?? paletteColor(index) }))
    .filter(({ item }) => item.value > 0)
    .sort((a, b) => b.item.value - a.item.value);
  const total = sum(shown.map(({ item }) => item.value));
  const boxes = squarify(
    shown.map(({ item }) => item.value),
    { x: 0, y: 0, w: width, h: height },
  );
  const active = shown.find(({ item }) => item.key === hovered);

  return (
    <div ref={ref} className={cn('relative h-60 w-full', className)}>
      <ul className="sr-only" aria-label={label}>
        {items.map((item) => (
          <li key={item.key}>
            {item.label}: {item.display} ({formatShare(total > 0 ? Math.max(item.value, 0) / total : 0)})
          </li>
        ))}
      </ul>
      {width > 0 &&
        shown.map(({ item, color }, index) => {
          const box = boxes[index];
          const roomy = box.w >= TEXT_MIN.w && box.h >= TEXT_MIN.h;
          return (
            <div
              key={item.key}
              aria-hidden
              className="absolute overflow-hidden rounded-md px-2 py-1.5 transition-colors"
              style={{
                left: box.x + GAP / 2,
                top: box.y + GAP / 2,
                width: Math.max(box.w - GAP, 0),
                height: Math.max(box.h - GAP, 0),
                backgroundColor: tint(color, hovered === item.key ? 30 : 18),
              }}
              onPointerEnter={() => setHovered(item.key)}
              onPointerMove={(event) => {
                const at = pointerIn(ref.current, event);
                if (at) setCard(cardBeside(at));
              }}
              onPointerLeave={() => {
                setHovered(null);
                setCard(null);
              }}
            >
              {roomy && (
                <>
                  <p className="truncate text-xs font-medium text-foreground">{item.label}</p>
                  <p className="truncate text-xs text-muted-foreground tabular-nums">{item.display}</p>
                </>
              )}
            </div>
          );
        })}
      {active && card && (
        <ChartHoverCard aria-hidden title={active.item.label} className="pointer-events-none absolute z-10 w-max" style={card}>
          <ChartTooltipRow swatch="square" color={active.color} label={formatShare(active.item.value / total)} value={active.item.display} />
        </ChartHoverCard>
      )}
    </div>
  );
}
