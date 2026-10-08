import { RefreshCw } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { usePreFileCheck } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PreFileCheck, PreFileFinding, TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DocumentLink } from '../../shared/document-link';
import { Notice } from '../../shared/notice';
import { ErrorState, RowsSkeleton } from '../../shared/query-states';
import { fill } from '../../shared/text';
import { parseSkipped } from '../return-model';

/** The server's per-document reasons we have a translation for. */
const KNOWN_DOCUMENT_REASONS: Record<string, 'noShipTo' | 'noLedgerRows' | 'incomeDiffers' | 'incomeWithoutTaxData' | 'directEntry'> = {
  'No ship-to state': 'noShipTo',
  'No tax-ledger rows for this agency: its income is not on the return': 'noLedgerRows',
  'Income differs from the sales the return counts': 'incomeDiffers',
  'Income without tax data': 'incomeWithoutTaxData',
  'Direct entry on the payable account': 'directEntry',
};

interface FindingBlockProps {
  finding: PreFileFinding;
  check: PreFileCheck;
}

function FindingBlock({ finding, check }: Readonly<FindingBlockProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.returnPage.preFile;
  const titles = tp.findingTitles as Record<string, string>;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const reasons = tp.docReasons as Record<string, string>;
  const description =
    finding.code === 'net_sales_difference' && check.comparison
      ? fill(tp.findingDescriptions.net_sales_difference, {
          state: check.stateCode,
          income: formatMoney(check.comparison.incomeShippedToState),
          returnNet: formatMoney(check.comparison.returnNetSales),
        })
      : ((tp.findingDescriptions as Record<string, string>)[finding.code] ?? finding.message);
  const showReturnColumn = finding.documents.some((document) => document.returnAmount !== undefined);

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`finding-${finding.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={finding.severity === 'error' ? 'destructive' : 'warning'}>{tp.severity[finding.severity]}</Badge>
        <p className="font-medium">{titles[finding.code] ?? finding.code}</p>
        <span className="text-xs text-muted-foreground">
          {fill(tp.documentsCount, { count: finding.count })}
          {' · '}
          {fill(tp.amountTotal, { amount: formatMoney(finding.amount) })}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {finding.documents.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tp.documentColumn}</TableHead>
              <TableHead>{tp.dateColumn}</TableHead>
              <TableHead>{tp.customerColumn}</TableHead>
              <TableHead className="text-right">{tp.incomeColumn}</TableHead>
              {showReturnColumn ? <TableHead className="text-right">{tp.returnColumn}</TableHead> : null}
              <TableHead>{tp.reasonColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {finding.documents.map((document) => {
              const known = KNOWN_DOCUMENT_REASONS[document.reason];
              return (
                <TableRow key={`${document.documentType}-${document.documentId}`}>
                  <TableCell>
                    <DocumentLink type={document.documentType} id={document.documentId} number={document.number} />
                  </TableCell>
                  <TableCell>{formatDate(document.date)}</TableCell>
                  <TableCell>{document.contactName ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(document.amount)}</TableCell>
                  {showReturnColumn ? (
                    <TableCell className="text-right tabular-nums">
                      {document.returnAmount === undefined ? '—' : formatMoney(document.returnAmount)}
                    </TableCell>
                  ) : null}
                  <TableCell className="max-w-[20rem] whitespace-normal text-muted-foreground">
                    {known ? reasons[known] : document.reason}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      {finding.truncated ? <p className="text-xs text-muted-foreground">{tp.truncated}</p> : null}
    </div>
  );
}

interface PreFileCheckResultProps {
  check: PreFileCheck;
  /** The return is filed: the checks that compare the worksheet no longer run. */
  filed?: boolean;
}

/** What the pre-file check found: OK to file or the findings with their documents, and the checks that did not run. */
export function PreFileCheckResult({ check, filed }: Readonly<PreFileCheckResultProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.returnPage.preFile;
  const { formatMoney } = useWeldbooksFormat();

  return (
    <>
      {check.ok ? (
        <Notice tone="success" title={tp.ok} data-testid="pre-file-ok">
          <p>{tp.okDescription}</p>
        </Notice>
      ) : (
        <Notice tone="warning" data-testid="pre-file-issues">
          <p className="font-medium">
            {check.findings.length === 1 ? tp.issuesOne : fill(tp.issuesMany, { count: check.findings.length })}
          </p>
        </Notice>
      )}

      {check.comparison ? (
        <dl className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-3" data-testid="pre-file-comparison">
          <div>
            <dt className="text-xs text-muted-foreground">{tp.returnNetSales}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(check.comparison.returnNetSales)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{fill(tp.incomeShipped, { state: check.stateCode })}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(check.comparison.incomeShippedToState)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tp.difference}</dt>
            <dd
              className={
                check.comparison.difference === 0
                  ? 'font-medium tabular-nums'
                  : 'font-medium tabular-nums text-destructive'
              }
            >
              {formatMoney(check.comparison.difference)}
            </dd>
          </div>
        </dl>
      ) : null}

      {check.findings.map((finding) => (
        <FindingBlock key={finding.code} finding={finding} check={check} />
      ))}

      {check.skipped.length > 0 ? (
        <div className="space-y-1 text-sm" data-testid="pre-file-skipped">
          <p className="font-medium">{tp.skippedTitle}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {check.skipped.map((entry) => {
              const skipped = parseSkipped(entry);
              const codes = tp.skippedCodes as Record<string, string>;
              const reasons = tp.skippedReasons as Record<string, string>;
              return (
                <li key={entry}>
                  <span className="text-foreground">{codes[skipped.code] ?? skipped.code}</span>
                  {': '}
                  {skipped.reason ? reasons[skipped.reason] : skipped.raw}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {filed ? <p className="text-xs text-muted-foreground">{tp.filedNotice}</p> : null}
    </>
  );
}

interface PreFileCheckCardProps {
  ret: TaxReturnDetail;
  /** Run the check (the tab is open). */
  enabled: boolean;
}

/** The pre-file check: the return's net sales against income, with the documents behind each finding. */
export function PreFileCheckCard({ ret, enabled }: Readonly<PreFileCheckCardProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.returnPage.preFile;
  const filed = ret.status === 'filed' || ret.status === 'paid';
  const open = ret.status === 'open';
  const query = usePreFileCheck(ret.id, { enabled: enabled && !open });
  const check = query.data;

  return (
    <Card data-testid="pre-file-check-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{tp.title}</CardTitle>
          <p className="text-xs text-muted-foreground">{tp.description}</p>
        </div>
        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} aria-hidden="true" />
            {tp.recheck}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {open ? (
          <p className="text-sm text-muted-foreground">{tp.notAvailable}</p>
        ) : query.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : check ? (
          <PreFileCheckResult check={check} filed={filed} />
        ) : null}
      </CardContent>
    </Card>
  );
}
