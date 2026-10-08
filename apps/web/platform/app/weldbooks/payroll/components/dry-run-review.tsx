import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { CsvImportResult, CsvProblem } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../../fixed-assets/text';
import { judgeDryRun, payrollBalance } from '../csv-mapping';

interface DryRunReviewProps {
  /** The dry run: what each payroll would post. Null while it has not run, or failed. */
  result: CsvImportResult | null;
  /** The per-row problems of a rejected file. */
  problems: readonly CsvProblem[] | null;
  /** The message of a dry run that failed without row problems. */
  errorMessage: string | null;
  loading: boolean;
  /** Account id to "1000 — Checking" for the entry lines. */
  accountName: (accountId: string) => string;
  importing: boolean;
  /** The user may post entries (journal:create). */
  canImport: boolean;
  onImport: () => void;
  onCheckAgain: () => void;
}

/**
 * The dry run of a payroll file: the entries that would be posted with their
 * balance check, the problems found per row, and the import button, which
 * stays off until every entry balances and nothing failed.
 */
export function DryRunReview({
  result,
  problems,
  errorMessage,
  loading,
  accountName,
  importing,
  canImport,
  onImport,
  onCheckAgain,
}: Readonly<DryRunReviewProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.assets.payroll.wizard.review;
  const categories = t.weldbooksUs.assets.payroll.categories as Record<string, string>;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const verdict = judgeDryRun(result);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="dry-run-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {tr.checking}
      </p>
    );
  }

  const failedToRun = !result;

  return (
    <div className="space-y-4" data-testid="dry-run-review">
      {failedToRun ? (
        <Card className="border-destructive/50" data-testid="dry-run-problems">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {problems ? fill(tr.problemsTitle, { count: problems.length }) : tr.failedTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {errorMessage && !problems ? <p role="alert">{errorMessage}</p> : null}
            {problems ? (
              <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5">
                {problems.map((problem, index) => (
                  <li key={`${problem.row}-${index}`}>{fill(tr.problemRow, { row: problem.row, message: problem.message })}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground">{tr.fixHelp}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {result.imports.length === 0 ? tr.nothing : fill(tr.payrolls, { count: result.imports.length })}
          </p>

          {verdict.unbalanced.length > 0 ? (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="dry-run-unbalanced">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {tr.unbalancedBlock}
            </p>
          ) : null}

          {result.failed.length > 0 ? (
            <Card className="border-destructive/50" data-testid="dry-run-failed">
              <CardHeader>
                <CardTitle className="text-base text-destructive">{tr.failedTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {result.failed.map((item) => (
                    <li key={`${item.payDate}-${item.error}`}>
                      {formatDate(item.payDate)}: {item.error}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {result.imports.map((payroll) => {
            const balance = payrollBalance(payroll);
            return (
              <Card key={`${payroll.payDate}-${payroll.totalDebit}`} data-testid={`payroll-${payroll.payDate}`}>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="text-base">{formatDate(payroll.payDate)}</CardTitle>
                  <Badge variant={balance.balanced ? 'success' : 'destructive'} className="gap-1" data-testid="balance-badge">
                    {balance.balanced ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}
                    {balance.balanced ? tr.balanced : tr.unbalanced}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.keys(payroll.summary).length > 0 ? (
                    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                      {Object.entries(payroll.summary)
                        .filter(([, value]) => value !== 0)
                        .map(([key, value]) => (
                          <div key={key} className="flex gap-2">
                            <dt className="text-muted-foreground">{categories[key] ?? key}</dt>
                            <dd className="font-medium tabular-nums">{formatMoney(value)}</dd>
                          </div>
                        ))}
                    </dl>
                  ) : null}
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{tr.columns.account}</TableHead>
                          <TableHead>{tr.columns.memo}</TableHead>
                          <TableHead className="text-right">{tr.columns.debit}</TableHead>
                          <TableHead className="text-right">{tr.columns.credit}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payroll.lines.map((line, index) => (
                          <TableRow key={`${line.accountId}-${index}`}>
                            <TableCell>{accountName(line.accountId)}</TableCell>
                            <TableCell className="max-w-[260px] truncate text-muted-foreground">{line.description ?? ''}</TableCell>
                            <TableCell className="text-right tabular-nums">{line.debit ? formatMoney(line.debit) : ''}</TableCell>
                            <TableCell className="text-right tabular-nums">{line.credit ? formatMoney(line.credit) : ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={2}>{tr.columns.totals}</TableCell>
                          <TableCell className="text-right tabular-nums" data-testid="total-debit">
                            {formatMoney(balance.debit)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" data-testid="total-credit">
                            {formatMoney(balance.credit)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onCheckAgain} disabled={importing}>
          {tr.checkAgain}
        </Button>
        {canImport ? (
          <Button type="button" onClick={onImport} disabled={!verdict.canImport || importing} data-testid="import-payrolls">
            {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {importing ? tr.importing : tr.import}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
