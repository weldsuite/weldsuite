/**
 * A table from a `show_table` spec, on the library's `Table`. Headers sort
 * (numbers by value, text by the reader's locale); inline it shows the first
 * rows and the expanded view shows all of them.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { TableCell as Cell, TableVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { compareCells, formatValue } from './format';

/** Rows shown in the chat before "Show all". */
export const INLINE_TABLE_ROWS = 10;

type Sort = { column: number; direction: 'asc' | 'desc' } | null;

interface VisualTableProps {
  visual: TableVisual;
  locale: string;
  expanded?: boolean;
  /** A row was clicked: ask about it. */
  onPickRow?: (row: Cell[]) => void;
  sortLabel: (column: string) => string;
}

function alignClass(align: 'left' | 'right' | 'center' | undefined, numeric: boolean): string {
  const side = align ?? (numeric ? 'right' : 'left');
  if (side === 'right') return 'text-right';
  if (side === 'center') return 'text-center';
  return 'text-left';
}

export function VisualTable({ visual, locale, expanded = false, onPickRow, sortLabel }: Readonly<VisualTableProps>) {
  const [sort, setSort] = useState<Sort>(null);
  const numericColumns = useMemo(
    () => visual.columns.map((_, i) => visual.rows.every((row) => row[i] === null || typeof row[i] === 'number')),
    [visual],
  );
  const rows = useMemo(() => {
    if (!sort) return visual.rows;
    const sorted = [...visual.rows].sort((a, b) => compareCells(a[sort.column], b[sort.column], locale));
    return sort.direction === 'desc' ? sorted.reverse() : sorted;
  }, [visual.rows, sort, locale]);
  const shown = expanded ? rows : rows.slice(0, INLINE_TABLE_ROWS);

  const toggle = (column: number) =>
    setSort((current) => {
      if (current?.column !== column) return { column, direction: numericColumns[column] ? 'desc' : 'asc' };
      if (current.direction === (numericColumns[column] ? 'desc' : 'asc')) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return null;
    });

  return (
    <div className={cn('overflow-hidden rounded-lg border', expanded && 'max-h-[70vh] overflow-y-auto')}>
      <Table className="text-[13px]">
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            {visual.columns.map((column, i) => {
              const active = sort?.column === i;
              let SortIcon = ArrowUpDown;
              if (active) SortIcon = sort.direction === 'asc' ? ArrowUp : ArrowDown;
              let ariaSort: 'ascending' | 'descending' | 'none' = 'none';
              if (active) ariaSort = sort.direction === 'asc' ? 'ascending' : 'descending';
              return (
                <TableHead
                  key={`${column.label}-${i}`}
                  aria-sort={ariaSort}
                  className={cn('h-9 px-3', alignClass(column.align, numericColumns[i]))}
                >
                  <button
                    type="button"
                    onClick={() => toggle(i)}
                    title={sortLabel(column.label)}
                    className={cn(
                      'inline-flex items-center gap-1 font-medium hover:text-foreground',
                      numericColumns[i] && column.align !== 'left' && 'flex-row-reverse',
                    )}
                  >
                    {column.label}
                    <SortIcon className={cn('size-3', active ? 'opacity-100' : 'opacity-40')} aria-hidden />
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, r) => (
            <TableRow
              // Rows have no id; their content plus position keeps keys stable across sorts.
              key={`${r}-${row.map(String).join('|').slice(0, 80)}`}
              className={cn(onPickRow && 'cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none')}
              tabIndex={onPickRow ? 0 : undefined}
              onClick={onPickRow ? () => onPickRow(row) : undefined}
              onKeyDown={
                onPickRow
                  ? (event) => {
                      if (event.key === 'Enter') onPickRow(row);
                    }
                  : undefined
              }
            >
              {visual.columns.map((column, c) => (
                <TableCell
                  key={`${column.label}-${c}`}
                  className={cn(
                    'px-3 py-1.5 align-top',
                    alignClass(column.align, numericColumns[c]),
                    numericColumns[c] && 'tabular-nums',
                  )}
                >
                  {formatValue(row[c], column.format, locale)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
