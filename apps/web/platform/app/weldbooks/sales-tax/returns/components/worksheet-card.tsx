import { Link } from '@tanstack/react-router';
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
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  DEDUCTION_KEYS,
  type ReturnLine,
  type ReturnSummary,
  type TaxReturnDetail,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { Notice } from '../../shared/notice';
import { fill, toCents } from '../../shared/text';

interface WorksheetRowProps {
  label: string;
  value: string;
  indent?: boolean;
  strong?: boolean;
  testId?: string;
}

function WorksheetRow({ label, value, indent, strong, testId }: Readonly<WorksheetRowProps>) {
  return (
    <TableRow className={cn(strong && 'bg-muted/40')} data-testid={testId}>
      <TableCell className={cn(indent && 'pl-8 text-muted-foreground', strong && 'font-semibold')}>{label}</TableCell>
      <TableCell className={cn('text-right tabular-nums', strong && 'font-semibold')}>{value}</TableCell>
    </TableRow>
  );
}

interface LocationTableProps {
  title: string;
  lines: readonly ReturnLine[];
}

/** Tax by reporting location: county, city, district or the state's location code. */
function LocationTable({ title, lines }: Readonly<LocationTableProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.salesTax.center.returnPage.byLocation;
  const levels = t.weldbooksUs.salesTax.center.levels as Record<string, string>;
  const { formatMoney } = useWeldbooksFormat();
  const totalTaxable = lines.reduce((sum, line) => sum + toCents(line.taxableSales), 0) / 100;
  const totalTax = lines.reduce((sum, line) => sum + toCents(line.tax), 0) / 100;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tl.location}</TableHead>
              <TableHead>{tl.level}</TableHead>
              <TableHead>{tl.reportingCode}</TableHead>
              <TableHead className="text-right">{tl.rate}</TableHead>
              <TableHead className="text-right">{tl.taxableSales}</TableHead>
              <TableHead className="text-right">{tl.tax}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {tl.empty}
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line) => (
                <TableRow key={`${line.jurisdictionCode}|${line.reportingCode}|${line.rate}`}>
                  <TableCell>
                    <span className="font-medium">{line.jurisdictionName || line.jurisdictionCode}</span>
                    {line.jurisdictionName && line.jurisdictionCode ? (
                      <span className="ml-2 text-xs text-muted-foreground">{line.jurisdictionCode}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{levels[line.level] ?? line.level}</TableCell>
                  <TableCell>{line.reportingCode || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(line.rate.toFixed(4))}%</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(line.taxableSales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(line.tax)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {lines.length > 1 ? (
            <TableFooter>
              <TableRow className="font-semibold">
                <TableCell colSpan={4}>{t.weldbooksUs.salesTax.center.common.total}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(totalTaxable)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(totalTax)}</TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </div>
  );
}

/** The notices under the worksheet: what the numbers include and what to look at. */
function WorksheetNotices({ summary }: Readonly<{ summary: ReturnSummary }>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.salesTax.center.returnPage.worksheet;
  const { formatMoney } = useWeldbooksFormat();

  return (
    <div className="space-y-2">
      {summary.uncuredExempt.lines > 0 ? (
        <Notice
          tone="warning"
          title={tw.uncuredTitle}
          data-testid="uncured-notice"
          action={
            <Link to="/weldbooks/sales-tax/certificates/reports" className="text-sm font-medium underline underline-offset-2">
              {tw.viewMissingCertificates}
            </Link>
          }
        >
          <p>
            {fill(summary.uncuredExempt.lines === 1 ? tw.uncuredOne : tw.uncuredMany, {
              count: summary.uncuredExempt.lines,
              sales: formatMoney(summary.uncuredExempt.sales),
              tax: formatMoney(summary.uncuredExempt.tax),
            })}
          </p>
        </Notice>
      ) : null}
      {summary.previouslyReported ? (
        <Notice tone="info" data-testid="previously-reported-notice">
          <p>
            {fill(tw.previouslyReported, {
              sales: formatMoney(summary.previouslyReported.salesTaxDue),
              use: formatMoney(summary.previouslyReported.useTaxDue),
            })}{' '}
            <Link
              to="/weldbooks/sales-tax/returns/$id"
              params={{ id: summary.previouslyReported.returnId }}
              className="font-medium underline underline-offset-2"
            >
              {t.weldbooksUs.salesTax.center.returnPage.amends}
            </Link>
          </p>
        </Notice>
      ) : null}
      {summary.carriedForward && summary.carriedForward.rowCount > 0 ? (
        <Notice tone="info" data-testid="carried-forward-notice">
          <p>
            {fill(summary.carriedForward.rowCount === 1 ? tw.carriedForwardOne : tw.carriedForwardMany, {
              count: summary.carriedForward.rowCount,
              tax: formatMoney(summary.carriedForward.taxAmount),
            })}
          </p>
        </Notice>
      ) : null}
      {summary.totalTaxDue < 0 ? (
        <Notice tone="warning">
          <p>{tw.creditNotice}</p>
        </Notice>
      ) : null}
      {summary.foreignCurrencyRows > 0 ? (
        <Notice tone="info">
          <p>
            {fill(summary.foreignCurrencyRows === 1 ? tw.foreignCurrencyOne : tw.foreignCurrencyMany, {
              count: summary.foreignCurrencyRows,
            })}
          </p>
        </Notice>
      ) : null}
    </div>
  );
}

/** The worksheet of a calculated return: gross sales to tax due, then the tax by location. */
export function WorksheetCard({ ret }: Readonly<{ ret: TaxReturnDetail }>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const tw = tc.returnPage.worksheet;
  const bases = tc.bases as Record<string, string>;
  const { formatMoney, formatDateTime } = useWeldbooksFormat();
  const summary = ret.summary;
  if (!summary) return null;

  const deductionLabels = tw.deductionLabels as Record<string, string>;
  const deductions = DEDUCTION_KEYS.filter((key) => toCents(summary.deductions[key] ?? 0) !== 0);
  const lines = ret.lines ?? [];

  return (
    <Card data-testid="worksheet-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{tw.title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {fill(tc.basisLabel, { basis: bases[summary.reportingBasis] ?? summary.reportingBasis })}
          {' · '}
          {fill(summary.documentCount === 1 ? tw.documentsCountOne : tw.documentsCountMany, {
            count: summary.documentCount,
          })}
          {' · '}
          {fill(tw.calculatedAt, { date: formatDateTime(summary.calculatedAt) })}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableBody>
              <WorksheetRow label={tw.grossSales} value={formatMoney(summary.grossSales)} strong testId="ws-gross-sales" />
              {deductions.length === 0 ? (
                <TableRow>
                  <TableCell className="pl-8 text-muted-foreground" colSpan={2}>
                    {tw.noDeductions}
                  </TableCell>
                </TableRow>
              ) : (
                deductions.map((key) => (
                  <WorksheetRow
                    key={key}
                    label={deductionLabels[key] ?? key}
                    value={formatMoney(summary.deductions[key])}
                    indent
                    testId={`ws-deduction-${key}`}
                  />
                ))
              )}
              <WorksheetRow label={tw.totalDeductions} value={formatMoney(summary.totalDeductions)} testId="ws-total-deductions" />
              <WorksheetRow label={tw.taxableSales} value={formatMoney(summary.taxableSales)} strong testId="ws-taxable-sales" />
              <WorksheetRow label={tw.salesTaxDue} value={formatMoney(summary.salesTaxDue)} testId="ws-sales-tax-due" />
              <WorksheetRow label={tw.useTaxDue} value={formatMoney(summary.useTaxDue)} testId="ws-use-tax-due" />
              <WorksheetRow label={tw.totalTaxDue} value={formatMoney(summary.totalTaxDue)} strong testId="ws-total-tax-due" />
            </TableBody>
          </Table>
        </div>

        <WorksheetNotices summary={summary} />

        <LocationTable title={tc.returnPage.byLocation.title} lines={lines.filter((line) => line.kind === 'sales')} />
        {lines.some((line) => line.kind === 'use') ? (
          <LocationTable title={tc.returnPage.byLocation.useTitle} lines={lines.filter((line) => line.kind === 'use')} />
        ) : null}
      </CardContent>
    </Card>
  );
}
