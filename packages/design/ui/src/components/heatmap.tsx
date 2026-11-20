/**
 * A heatmap of counts by two dimensions, such as weekday by hour: rounded
 * cells in steps of one colour, the busiest at full strength, row names on
 * the left, a few column names underneath and, optionally, a Less–More key.
 * Under the pointer a cell gets a ring and a card with its name and count, in
 * the style of dub.co's analytics.
 *
 * It is a table: each row has a row header, each column a hidden column
 * header and each cell its count as text, so assistive tech reads every
 * value. The component holds no text of its own: names, the count's label and
 * the key's words come in as props.
 */

import { useRef, useState } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { cn } from '@weldsuite/ui/lib/utils';

export interface HeatmapProps {
  /** The row names, such as weekdays. */
  rows: string[];
  /** The column names, such as hours. */
  columns: string[];
  /** Counts as `values[row][column]`; missing cells count as zero. */
  values: number[][];
  /** The columns whose names show under the grid; four spread across by default. */
  columnTicks?: number[];
  /** The cells' colour; `--chart-1` by default. */
  color?: string;
  formatValue?: (value: number) => string;
  /** What a count is, in the card: "Tickets". */
  valueLabel: string;
  /** The card's title for a cell; the row and column names by default. */
  cellTitle?: (row: string, column: string) => string;
  /** Words at the ends of the key; no key without them. */
  legend?: { less: string; more: string };
  /** Names the table for assistive tech. */
  caption?: string;
  className?: string;
}

/** The cell colour at a 0-1 intensity: the faintest still shows the grid. */
const shade = (color: string, intensity: number) =>
  `color-mix(in oklab, ${color} ${Math.round(8 + intensity * 92)}%, transparent)`;

function defaultTicks(count: number): number[] {
  if (count <= 4) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / 4);
  return Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step);
}

export function Heatmap({
  rows,
  columns,
  values,
  columnTicks,
  color = 'var(--chart-1)',
  formatValue = String,
  valueLabel,
  cellTitle = (row, column) => `${row} ${column}`,
  legend,
  caption,
  className,
}: Readonly<HeatmapProps>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ row: number; column: number; left: number; top: number } | null>(null);
  const valueAt = (row: number, column: number) => values[row]?.[column] ?? 0;
  const max = Math.max(0, ...rows.flatMap((_, row) => columns.map((__, column) => valueAt(row, column))));
  const ticks = new Set(columnTicks ?? defaultTicks(columns.length));

  const show = (row: number, column: number, cell: HTMLElement) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const rect = cell.getBoundingClientRect();
    // Keep the card's middle 5rem from the edges so it stays inside the chart.
    const left = Math.min(Math.max(rect.left - box.left + rect.width / 2, 80), box.width - 80);
    setHovered({ row, column, left, top: rect.bottom - box.top + 6 });
  };

  return (
    <div ref={boxRef} className={cn('relative grid gap-2', className)}>
      <table className="w-full table-fixed border-separate border-spacing-0.5">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            <td className="w-10 p-0" />
            {columns.map((column) => (
              <th key={column} scope="col" className="p-0">
                <span className="sr-only">{column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row}>
              <th scope="row" className="truncate p-0 pr-2 text-left text-xs font-normal text-muted-foreground">
                {row}
              </th>
              {columns.map((column, c) => {
                const value = valueAt(r, c);
                const active = hovered?.row === r && hovered.column === c;
                return (
                  <td key={column} className="p-0">
                    <div
                      aria-hidden
                      className={cn('h-5 rounded-[4px]', active && 'ring-1 ring-foreground')}
                      style={{ backgroundColor: shade(color, max > 0 ? Math.max(value, 0) / max : 0) }}
                      onPointerEnter={(event) => show(r, c, event.currentTarget)}
                      onPointerLeave={() => setHovered(null)}
                    />
                    <span className="sr-only">{formatValue(value)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot aria-hidden>
          <tr>
            <td className="p-0" />
            {columns.map((column, c) => (
              <td key={column} className="overflow-visible p-0 pt-1 text-xs whitespace-nowrap text-muted-foreground">
                {ticks.has(c) ? column : null}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      {legend && (
        <div aria-hidden className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          <span className="mr-1">{legend.less}</span>
          {[0, 0.25, 0.5, 0.75, 1].map((step) => (
            <span key={step} className="size-3 rounded-[3px]" style={{ backgroundColor: shade(color, step) }} />
          ))}
          <span className="ml-1">{legend.more}</span>
        </div>
      )}
      {hovered && (
        <ChartHoverCard
          aria-hidden
          title={cellTitle(rows[hovered.row], columns[hovered.column])}
          className="pointer-events-none absolute z-10 w-max -translate-x-1/2"
          style={{ left: hovered.left, top: hovered.top }}
        >
          <ChartTooltipRow swatch="square" color={color} label={valueLabel} value={formatValue(valueAt(hovered.row, hovered.column))} />
        </ChartHoverCard>
      )}
    </div>
  );
}
