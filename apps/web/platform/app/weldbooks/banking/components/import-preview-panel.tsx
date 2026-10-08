import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ImportPreview, ImportProblem, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

/** The mismatch message in the user's language, built from the server's problem details. */
export function problemMessage(
  problem: Pick<ImportProblem, 'code' | 'message' | 'details'>,
  labels: { accountMismatch: string; currencyMismatch: string },
): string {
  const details = problem.details ?? {};
  if (problem.code === 'ACCOUNT_MISMATCH') {
    return labels.accountMismatch
      .replace('{fileLast4}', String(details.fileAccountLast4 ?? '????'))
      .replace('{accountLast4}', String(details.bankAccountLast4 ?? '????'));
  }
  if (problem.code === 'CURRENCY_MISMATCH') {
    return labels.currencyMismatch
      .replace('{fileCurrency}', String(details.fileCurrency ?? '???'))
      .replace('{accountCurrency}', String(details.bankAccountCurrency ?? '???'));
  }
  return problem.message;
}

function Stat({ label, children, className }: Readonly<{ label: string; children: React.ReactNode; className?: string }>) {
  return (
    <div className={cn('space-y-0.5', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}

interface ImportPreviewPanelProps {
  preview: ImportPreview;
  bankAccount: UsBankAccount | undefined;
}

/**
 * What a statement file holds before anything is imported: the detected
 * format, whether it belongs to the chosen bank account, its dates and
 * balances, how many lines are new, and the first lines as parsed.
 */
export function ImportPreviewPanel({ preview, bankAccount }: Readonly<ImportPreviewPanelProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.banking.importPreview;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const currency = preview.currency ?? bankAccount?.currency ?? undefined;
  const fileLast4 = preview.account?.accountNumberLast4;
  const accountLast4 = bankAccount?.accountNumberLast4;
  const matches = !!fileLast4 && !!accountLast4 && fileLast4.toLowerCase() === accountLast4.toLowerCase();
  const total = preview.totalParsed ?? 0;
  const duplicates = preview.duplicates ?? 0;
  const sample = preview.sample ?? [];
  const showCheck = sample.some((line) => line.checkNumber);
  const errors = preview.errors ?? [];

  return (
    <div className="space-y-4" data-testid="import-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{tp.formats[preview.format]}</Badge>
        {fileLast4 ? (
          matches ? (
            <Badge variant="success">
              <CheckCircle2 />
              {tp.accountMatches.replace('{last4}', fileLast4)}
            </Badge>
          ) : (
            <Badge variant="outline">{tp.fileAccount.replace('{last4}', fileLast4)}</Badge>
          )
        ) : null}
        {preview.accounts && preview.accounts.length > 1 ? (
          <Badge variant="outline">{tp.severalAccounts.replace('{count}', String(preview.accounts.length))}</Badge>
        ) : null}
      </div>

      {preview.problem ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          data-testid="import-problem"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problemMessage(preview.problem, tp)}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={tp.dateRange}>
          {preview.dateRange ? `${formatDate(preview.dateRange.from)} – ${formatDate(preview.dateRange.to)}` : '—'}
        </Stat>
        <Stat label={tp.openingBalance}>
          {preview.openingBalance === undefined ? '—' : formatMoney(preview.openingBalance, currency)}
        </Stat>
        <Stat label={tp.closingBalance}>
          {preview.closingBalance === undefined ? '—' : formatMoney(preview.closingBalance, currency)}
        </Stat>
        <Stat label={tp.linesInFile}>{total}</Stat>
        <Stat label={tp.alreadyImported}>{preview.duplicates === null || preview.duplicates === undefined ? '—' : duplicates}</Stat>
        <Stat label={tp.newLines}>{Math.max(0, total - duplicates)}</Stat>
      </div>

      {errors.length > 0 ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">{tp.readErrors.replace('{count}', String(errors.length))}</p>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
            {errors.slice(0, 20).map((error) => (
              <li key={`${error.line ?? ''}:${error.message}`}>
                {error.line ? `${tp.line.replace('{line}', String(error.line))} ` : ''}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sample.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{tp.sampleTitle.replace('{count}', String(sample.length))}</p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tp.columns.date}</TableHead>
                  <TableHead>{tp.columns.description}</TableHead>
                  {showCheck ? <TableHead>{tp.columns.checkNumber}</TableHead> : null}
                  <TableHead className="text-right">{tp.columns.amount}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sample.map((line, index) => (
                  <TableRow key={`${line.externalId ?? ''}:${line.date}:${line.amount}:${index}`}>
                    <TableCell className="whitespace-nowrap">{formatDate(line.date)}</TableCell>
                    <TableCell className="max-w-[420px] truncate">{line.description || line.counterpartyName || '—'}</TableCell>
                    {showCheck ? <TableCell>{line.checkNumber ?? ''}</TableCell> : null}
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        line.amount >= 0 && 'text-emerald-600 dark:text-emerald-400',
                      )}
                    >
                      {formatMoney(line.amount, currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
