import { Link } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { DepreciationRow, LedgerDepreciationRow } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../text';

/** The yearly schedule of a book. The section 179 and bonus columns appear only when something was taken. */
export function AnnualScheduleTable({ rows }: Readonly<{ rows: readonly DepreciationRow[] }>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.assets.fixedAssets.detail.annual;
  const { formatMoney } = useWeldbooksFormat();
  const showSection179 = rows.some((row) => row.section179 !== 0);
  const showBonus = rows.some((row) => row.bonus !== 0);

  return (
    <div className="overflow-x-auto rounded-md border" data-testid="annual-schedule">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{ta.period}</TableHead>
            <TableHead className="text-right">{ta.amount}</TableHead>
            {showSection179 || showBonus ? <TableHead className="text-right">{ta.regular}</TableHead> : null}
            {showSection179 ? <TableHead className="text-right">{ta.section179}</TableHead> : null}
            {showBonus ? <TableHead className="text-right">{ta.bonus}</TableHead> : null}
            <TableHead className="text-right">{ta.accumulated}</TableHead>
            <TableHead className="text-right">{ta.remaining}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.label}-${row.periodStart}`}>
              <TableCell className="whitespace-nowrap font-medium">{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(row.amount)}</TableCell>
              {showSection179 || showBonus ? <TableCell className="text-right tabular-nums">{formatMoney(row.regular)}</TableCell> : null}
              {showSection179 ? <TableCell className="text-right tabular-nums">{formatMoney(row.section179)}</TableCell> : null}
              {showBonus ? <TableCell className="text-right tabular-nums">{formatMoney(row.bonus)}</TableCell> : null}
              <TableCell className="text-right tabular-nums">{formatMoney(row.accumulated)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(row.remaining)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The ledger book's stored periods (months, or 4-4-5 periods) and whether each is posted. */
export function LedgerPostingsTable({ rows }: Readonly<{ rows: readonly LedgerDepreciationRow[] }>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.assets.fixedAssets.detail.monthly;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const posted = rows.filter((row) => row.journalEntryId).length;

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{tm.empty}</p>;

  return (
    <div className="space-y-2" data-testid="ledger-postings">
      <div>
        <p className="text-sm font-medium">{tm.title}</p>
        <p className="text-xs text-muted-foreground">
          {tm.description} {fill(tm.postedCount, { posted, total: rows.length })}
        </p>
      </div>
      <div className="max-h-96 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tm.period}</TableHead>
              <TableHead className="text-right">{tm.amount}</TableHead>
              <TableHead className="text-right">{tm.accumulated}</TableHead>
              <TableHead>{tm.status}</TableHead>
              <TableHead>{tm.entry}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(row.amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(row.accumulated)}</TableCell>
                <TableCell>
                  <Badge variant={row.journalEntryId ? 'success' : 'outline'}>{row.journalEntryId ? tm.posted : tm.scheduled}</Badge>
                </TableCell>
                <TableCell>
                  {row.journalEntryId ? (
                    <Link
                      to="/weldbooks/journal/$id"
                      params={{ id: row.journalEntryId }}
                      className="text-sm underline-offset-2 hover:underline"
                    >
                      {t.weldbooksUs.assets.common.view}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
