import Link from 'next/link';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import type { PoolGroupRow } from '@/lib/warmup-network-data';
import {
  POOL_STATUS_LABELS,
  formatRate,
  rateTone,
  type PoolStatus,
} from '@/lib/warmup-network';

const STATUS_VARIANT: Record<PoolStatus, 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  waiting: 'secondary',
  warming: 'warning',
  maintaining: 'success',
  paused: 'outline',
  error: 'destructive',
  removed: 'secondary',
};

const STATUS_DOT: Record<PoolStatus, string> = {
  waiting: 'bg-muted-foreground/40',
  warming: 'bg-amber-500',
  maintaining: 'bg-emerald-500',
  paused: 'bg-muted-foreground/40',
  error: 'bg-white',
  removed: 'bg-muted-foreground/40',
};

/** A pool mailbox's state as a pill with a leading dot. */
export function PoolStatusBadge({ status }: Readonly<{ status: PoolStatus }>) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} />
      {POOL_STATUS_LABELS[status]}
    </Badge>
  );
}

/** One headline number with a label and a line of context. */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: Readonly<{ label: string; value: string; hint?: React.ReactNode; tone?: 'default' | 'warning' }>) {
  return (
    <Card className="py-4">
      <CardContent className="space-y-1 px-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-semibold tabular-nums', tone === 'warning' && 'text-amber-600 dark:text-amber-400')}>
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** An inbox rate as text; amber below the health gate, a dash without data. */
export function RateText({ rate }: Readonly<{ rate: number | null }>) {
  const tone = rateTone(rate);
  return (
    <span
      className={cn('tabular-nums', tone === 'low' && 'font-medium text-amber-600 dark:text-amber-400', tone === 'none' && 'text-muted-foreground')}
      title={tone === 'none' ? 'Not enough judged emails yet' : undefined}
    >
      {formatRate(rate)}
    </span>
  );
}

/** Section heading with an optional note on its right. */
export function Section({
  title,
  note,
  children,
}: Readonly<{ title: string; note?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** A bordered table frame with the console's header and row rules. */
export function TableFrame({ head, children }: Readonly<{ head: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>{head}</TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">{children}</TableBody>
      </Table>
    </div>
  );
}

export function Th({ children, right = false }: Readonly<{ children?: React.ReactNode; right?: boolean }>) {
  return <TableHead className={cn('text-[13.5px]', right && 'text-right')}>{children}</TableHead>;
}

export function EmptyRow({ colSpan, children }: Readonly<{ colSpan: number; children: React.ReactNode }>) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** Mailboxes per domain, type or workspace: how many take part and how many are stalled. */
export function GroupTable({
  title,
  keyLabel,
  rows,
  empty,
  href,
  mono = false,
}: Readonly<{
  title: string;
  keyLabel: string;
  rows: PoolGroupRow[];
  empty: string;
  /** Link for a row, when there is a page for it. */
  href?: (row: PoolGroupRow) => string;
  mono?: boolean;
}>) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <TableFrame
        head={
          <>
            <Th>{keyLabel}</Th>
            <Th right>In network</Th>
            <Th right>Paused or error</Th>
          </>
        }
      >
        {rows.length === 0 && <EmptyRow colSpan={3}>{empty}</EmptyRow>}
        {rows.map((row) => (
          <TableRow key={row.key} className="h-10 hover:bg-muted/50">
            <TableCell className={cn('py-2', mono && 'font-mono text-xs')}>
              {href ? (
                <Link href={href(row)} className="underline-offset-2 hover:underline">
                  {row.label}
                </Link>
              ) : (
                row.label
              )}
            </TableCell>
            <TableCell className="py-2 text-right tabular-nums">{row.participating}</TableCell>
            <TableCell
              className={cn(
                'py-2 text-right tabular-nums',
                row.stalled > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
              )}
            >
              {row.stalled}
            </TableCell>
          </TableRow>
        ))}
      </TableFrame>
    </div>
  );
}
