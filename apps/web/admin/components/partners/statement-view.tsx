import { ExternalLink } from 'lucide-react';
import type { PartnerStatementView } from '@weldsuite/app-api-client/schemas/partners';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { formatDay, formatDecimal } from '@/lib/billing-format';
import { fill } from '@/lib/i18n';
import { partnersCopy } from '@/lib/partners-copy';
import { StatementStatusBadge } from './badges';

/** `2026-09-01T00:00:00.000Z` → `2026-09`. */
export function statementPeriodLabel(statement: Pick<PartnerStatementView, 'periodStart'>): string {
  return statement.periodStart.slice(0, 7);
}

/** One statement: totals, invoice links and one line per workspace. */
export function StatementView({ statement }: Readonly<{ statement: PartnerStatementView }>) {
  const t = partnersCopy().statements;
  const cur = statement.currency;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatementStatusBadge status={statement.status} />
        {statement.dueAt && <span className="text-muted-foreground">{fill(t.dueAt, { date: formatDay(statement.dueAt) })}</span>}
        {statement.paidAt && <span className="text-muted-foreground">{fill(t.paidAt, { date: formatDay(statement.paidAt) })}</span>}
        {statement.stripeInvoiceUrl && (
          <a href={statement.stripeInvoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
            {t.invoice}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {statement.stripeInvoicePdf && (
          <a href={statement.stripeInvoicePdf} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
            {t.pdf}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        {(
          [
            [t.totals.resale, statement.totalResale],
            [t.totals.due, statement.totalDue],
            [t.totals.margin, statement.totalMargin],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{formatDecimal(amount, cur)}</dd>
          </div>
        ))}
      </dl>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.lines.workspace}</TableHead>
              <TableHead className="text-right">{t.lines.days}</TableHead>
              <TableHead className="text-right">{t.lines.seats}</TableHead>
              <TableHead className="text-right">{t.lines.resale}</TableHead>
              <TableHead className="text-right">{t.lines.share}</TableHead>
              <TableHead className="text-right">{t.lines.floor}</TableHead>
              <TableHead className="text-right">{t.lines.creditFloor}</TableHead>
              <TableHead className="text-right">{t.lines.extraCredits}</TableHead>
              <TableHead className="text-right">{t.lines.due}</TableHead>
              <TableHead className="text-right">{t.lines.margin}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {statement.lines.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                  {t.lines.empty}
                </TableCell>
              </TableRow>
            )}
            {statement.lines.map((line) => (
              <TableRow key={line.workspaceId}>
                <TableCell className="font-medium">{line.workspaceName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.daysActive}/{line.daysInPeriod}
                </TableCell>
                <TableCell className="text-right tabular-nums">{line.seatsBilled || '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.resale, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.shareAmount, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.floorAmount, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.creditFloorAmount, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.extraCreditsAmount, cur)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatDecimal(line.due, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDecimal(line.margin, cur)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
