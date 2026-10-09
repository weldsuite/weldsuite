import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import type { ReportColumn, ReportDelta } from '@/lib/weldbooks/report-types';
import type { ReportRowModel } from './report-model';

export interface ReportTableLabels {
  account: string;
  change: string;
  changePercent: string;
}

interface ReportTableProps {
  columns: readonly ReportColumn[];
  rows: readonly ReportRowModel[];
  /** Two columns, current and prior: adds a Change and a Change % column. */
  comparing: boolean;
  /** Heading of a value column. */
  heading: (column: ReportColumn) => string;
  formatMoney: (value: string | number | null | undefined) => string;
  labels: ReportTableLabels;
  /** Replaces the plain label of an account row (a link to its ledger). */
  renderLabel?: (row: ReportRowModel) => ReactNode;
  /** Names the table for screen readers. */
  caption: string;
  /** Overrides the columns, for the trial balance's Debit and Credit. */
  valueColumns?: ReadonlyArray<{ key: string; heading: string }>;
}

function signed(delta: ReportDelta, formatMoney: ReportTableProps['formatMoney']): string {
  const n = Number(delta.amount);
  return n > 0 ? `+${formatMoney(delta.amount)}` : formatMoney(delta.amount);
}

function percent(delta: ReportDelta): string {
  if (delta.percent === null) return '—';
  return `${delta.percent > 0 ? '+' : ''}${delta.percent}%`;
}

/**
 * A financial statement as a table: one column per period, plus the change
 * columns of a comparison. Section rows head a block, subtotal and total rows
 * close it. The label column stays in view while the values scroll.
 */
export function ReportTable({
  columns,
  rows,
  comparing,
  heading,
  formatMoney,
  labels,
  renderLabel,
  caption,
  valueColumns,
}: Readonly<ReportTableProps>) {
  const cols = valueColumns ?? columns.map((c) => ({ key: c.key, heading: heading(c) }));
  const span = 1 + cols.length + (comparing ? 2 : 0);

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 min-w-56 bg-background">{labels.account}</TableHead>
            {cols.map((column) => (
              <TableHead key={column.key} className="min-w-28 whitespace-nowrap text-right">
                {column.heading}
              </TableHead>
            ))}
            {comparing ? (
              <>
                <TableHead className="min-w-28 whitespace-nowrap text-right">{labels.change}</TableHead>
                <TableHead className="min-w-24 whitespace-nowrap text-right">{labels.changePercent}</TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            if (row.kind === 'section') {
              return (
                <TableRow key={row.key} className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={span} className="sticky left-0 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {row.label}
                  </TableCell>
                </TableRow>
              );
            }
            const strong = row.kind === 'subtotal' || row.kind === 'total';
            return (
              <TableRow key={row.key} className={cn(row.kind === 'total' && 'border-t-2')}>
                <TableCell
                  className={cn('sticky left-0 z-10 bg-background', strong && 'font-semibold')}
                  style={{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }}
                >
                  {renderLabel && row.kind === 'account' ? (
                    renderLabel(row)
                  ) : (
                    <>
                      {row.code ? <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span> : null}
                      {row.label}
                    </>
                  )}
                </TableCell>
                {cols.map((column) => (
                  <TableCell
                    key={column.key}
                    className={cn('whitespace-nowrap text-right tabular-nums', strong && 'font-semibold')}
                  >
                    {formatMoney(row.values[column.key])}
                  </TableCell>
                ))}
                {comparing ? (
                  <>
                    <TableCell className={cn('whitespace-nowrap text-right tabular-nums', strong && 'font-semibold')}>
                      {row.delta ? signed(row.delta, formatMoney) : ''}
                    </TableCell>
                    <TableCell className={cn('whitespace-nowrap text-right tabular-nums', strong && 'font-semibold')}>
                      {row.delta ? percent(row.delta) : ''}
                    </TableCell>
                  </>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
