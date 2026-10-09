import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { useTaxWorksheetReport } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { fiscalYearContaining, fiscalYearFor, type FiscalYearConfig } from '@/lib/weldbooks/fiscal-year';
import { localToday } from '@/lib/weldbooks/format';
import type { TaxWorksheetLine, TaxWorksheetUnmapped } from '@/lib/weldbooks/report-types';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { ReportShell } from '../components/report-shell';
import { ReportToolbar } from '../components/report-toolbar';
import { useReportExport } from '../components/use-report-export';
import { useReportHeadings } from '../components/use-report-headings';
import { useReportParams } from '../components/use-report-params';

/** How many fiscal years the picker offers, newest first. */
const YEAR_CHOICES = 8;

function LineRow({
  line,
  expanded,
  onToggle,
  formatMoney,
}: Readonly<{
  line: TaxWorksheetLine;
  expanded: boolean;
  onToggle: () => void;
  formatMoney: (value: string | number | null | undefined) => string;
}>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const hasBeginning = line.beginningAmount !== undefined;
  const partlyDeductible = line.deductiblePercent !== undefined && line.deductiblePercent < 100;

  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40"
        aria-expanded={expanded}
        onClick={onToggle}
        disabled={line.accounts.length === 0}
      >
        <ChevronRight
          className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">{line.line}</span>
            {line.label}
          </span>
          {partlyDeductible ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {tr.worksheet.deductibleNote
                .replace('{percent}', String(line.deductiblePercent))
                .replace('{deductible}', formatMoney(line.deductibleAmount))
                .replace('{nonDeductible}', formatMoney(line.nonDeductibleAmount))}
              {line.nonDeductibleLine ? ` ${tr.worksheet.nonDeductibleOn.replace('{line}', line.nonDeductibleLine)}` : ''}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-right text-sm tabular-nums">
          {hasBeginning ? (
            <span className="block text-xs text-muted-foreground">
              {tr.worksheet.beginning}: {formatMoney(line.beginningAmount)}
            </span>
          ) : null}
          <span className="font-medium">{formatMoney(line.amount)}</span>
        </span>
      </button>
      {expanded && line.accounts.length > 0 ? (
        <ul className="border-t bg-muted/20 py-1 pl-10 pr-4 text-sm">
          {line.accounts.map((account) => (
            <li key={account.accountId} className="flex items-baseline justify-between gap-3 py-1">
              <Link to="/weldbooks/accounts/$id" params={{ id: account.accountId }} className="min-w-0 truncate hover:underline">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{account.code}</span>
                {account.name}
              </Link>
              <span className="shrink-0 tabular-nums">
                {account.beginningAmount !== undefined ? (
                  <span className="mr-3 text-xs text-muted-foreground">{formatMoney(account.beginningAmount)}</span>
                ) : null}
                {formatMoney(account.amount)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function UnmappedCallout({
  unmapped,
  formLabel,
  formatMoney,
}: Readonly<{
  unmapped: readonly TaxWorksheetUnmapped[];
  formLabel: string;
  formatMoney: (value: string | number | null | undefined) => string;
}>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.reports.worksheet;
  const reasons: Record<TaxWorksheetUnmapped['reason'], string> = {
    none: tw.reasonNone,
    other_form: tw.reasonOtherForm,
    unknown_line: tw.reasonUnknownLine,
  };

  return (
    <Card className="border-amber-500/50 bg-amber-500/5" role="region" aria-labelledby="worksheet-unmapped">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle id="worksheet-unmapped" className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
            {tw.unmappedTitle.replace('{count}', String(unmapped.length))}
          </CardTitle>
          <CardDescription>{tw.unmappedDescription.replace('{form}', formLabel)}</CardDescription>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/weldbooks/accounts/tax-lines">{tw.mapAccounts}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="text-sm">
          {unmapped.map((account) => (
            <li key={account.accountId} className="flex flex-wrap items-baseline justify-between gap-x-3 border-t py-1.5 first:border-t-0">
              <Link to="/weldbooks/accounts/$id" params={{ id: account.accountId }} className="hover:underline">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{account.code}</span>
                {account.name}
              </Link>
              <span className="flex items-center gap-3">
                <Badge variant="outline">{reasons[account.reason]}</Badge>
                <span className="tabular-nums">{formatMoney(account.amount)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Tax return worksheet (US): the fiscal year's trial balance grouped by the
 * lines of the entity's income-tax return, with the accounts behind each line,
 * for the accountant who prepares the return.
 */
export default function TaxWorksheetPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;
  const tw = tr.worksheet;
  const { code, entity, isResolved } = useCurrentJurisdiction();
  const isUs = code === 'US';
  const { formatMoney } = useWeldbooksFormat();
  const { rangeLabel } = useReportHeadings();
  const { params, update } = useReportParams();
  const [year, setYear] = useState<number | null>(null);
  const [includeZero, setIncludeZero] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const query = useMemo(
    () => ({ ...(year ? { year } : {}), ...(params.basis ? { basis: params.basis } : {}), ...(includeZero ? { includeZero: true } : {}) }),
    [year, params.basis, includeZero],
  );
  const reportQuery = useTaxWorksheetReport(query, { enabled: isUs });
  const worksheet = reportQuery.data;

  // The picker names fiscal years the way the server does: by the calendar year they end in.
  const fiscalConfig: FiscalYearConfig = useMemo(
    () =>
      entity?.fiscalYearConfig
        ? entity.fiscalYearConfig
        : { type: 'month', startMonth: entity?.fiscalYearStart ?? 1 },
    [entity?.fiscalYearConfig, entity?.fiscalYearStart],
  );
  const currentFiscalYear = fiscalYearContaining(fiscalConfig, localToday()).year;
  const selectedYear = year ?? (worksheet ? fiscalYearContaining(fiscalConfig, worksheet.period.from).year : currentFiscalYear);
  const yearOptions = useMemo(
    () =>
      Array.from({ length: YEAR_CHOICES }, (_, i) => {
        const value = currentFiscalYear - i;
        const range = fiscalYearFor(fiscalConfig, value);
        return { value, range: rangeLabel(range.start, range.end) };
      }),
    [currentFiscalYear, fiscalConfig, rangeLabel],
  );

  const periodLabel = worksheet ? `${worksheet.formLabel} · ${rangeLabel(worksheet.period.from, worksheet.period.to)}` : undefined;
  const { busy, exportCsv, exportPdf } = useReportExport('tax-worksheet', query, { periodLabel });

  const allCodes = useMemo(
    () => worksheet?.sections.flatMap((s) => s.lines.filter((l) => l.accounts.length > 0).map((l) => l.code)) ?? [],
    [worksheet],
  );
  const toggle = (lineCode: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(lineCode)) next.delete(lineCode);
      else next.add(lineCode);
      return next;
    });
  const sectionLabels = t.weldbooksUs.setup.taxSections as Record<string, string>;

  if (!isResolved) return <PageLoader fullScreen={false} />;

  if (!isUs) {
    return (
      <div className="space-y-2 p-4 sm:p-6">
        <h1 className="text-2xl font-semibold">{tw.title}</h1>
        <p className="text-sm text-muted-foreground">{tw.usOnly}</p>
      </div>
    );
  }

  const summary = worksheet?.summary;

  return (
    <ReportShell
      title={tw.title}
      subtitle={periodLabel}
      isLoading={reportQuery.isLoading}
      isError={reportQuery.isError && !worksheet}
      onRetry={() => void reportQuery.refetch()}
      toolbar={
        <ReportToolbar
          dates="none"
          params={params}
          onChange={update}
          defaults={{ basis: worksheet?.basis }}
          showCompare={false}
          showDimensions={false}
          isFetching={reportQuery.isFetching && !reportQuery.isLoading}
          exportControls={{ onCsv: () => void exportCsv(), onPdf: () => void exportPdf(), busy, disabled: !worksheet }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="worksheet-year">{tw.fiscalYear}</Label>
            <Select value={String(selectedYear)} onValueChange={(value) => setYear(Number(value))}>
              <SelectTrigger id="worksheet-year" className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.value} · {option.range}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox checked={includeZero} onCheckedChange={(checked) => setIncludeZero(checked === true)} />
            {tw.includeZero}
          </label>
        </ReportToolbar>
      }
    >
      {worksheet && summary ? (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">{tw.description.replace('{form}', worksheet.formLabel)}</p>

          {worksheet.unmapped.length > 0 ? (
            <UnmappedCallout unmapped={worksheet.unmapped} formLabel={worksheet.formLabel} formatMoney={formatMoney} />
          ) : null}

          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <CardTitle className="text-base">{tw.summaryTitle}</CardTitle>
              <Badge
                variant={summary.reconciles ? 'secondary' : 'outline'}
                className={cn(
                  'gap-1',
                  !summary.reconciles && 'border-amber-500/60 text-amber-700 dark:text-amber-400',
                )}
              >
                {summary.reconciles ? (
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                )}
                {summary.reconciles ? tw.reconciles : tw.doesNotReconcile}
              </Badge>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                {[
                  [tw.totalIncome, summary.totalIncome],
                  [tw.totalOtherIncome, summary.totalOtherIncome],
                  [tw.totalCogs, summary.totalCostOfGoodsSold],
                  [tw.totalDeductions, summary.totalDeductions],
                  [tw.netIncomeFromLines, summary.netIncomeFromLines],
                  [tw.notDeductibleTotal, summary.notDeductibleTotal],
                  [tw.unmappedNetIncome, summary.unmappedNetIncome],
                  [tw.netIncomePerBooks, summary.netIncomePerBooks],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 border-b py-1.5 last:border-b-0">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium tabular-nums">{formatMoney(value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                {summary.reconciles ? tw.reconcilesHelp : tw.doesNotReconcileHelp}
              </p>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{tw.linesTitle}</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(expanded.size > 0 ? new Set() : new Set(allCodes))}
              disabled={allCodes.length === 0}
            >
              {expanded.size > 0 ? tw.collapseAll : tw.expandAll}
            </Button>
          </div>

          {worksheet.sections.length === 0 ? (
            <p className="rounded-md border p-8 text-center text-sm text-muted-foreground">{tr.noActivity}</p>
          ) : (
            worksheet.sections.map((section) => (
              <section key={section.key} aria-labelledby={`worksheet-${section.key}`} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 id={`worksheet-${section.key}`} className="text-sm font-semibold text-muted-foreground">
                    {sectionLabels[section.key] ?? section.label}
                  </h3>
                  {section.total !== null ? (
                    <span className="text-sm font-semibold tabular-nums">{formatMoney(section.total)}</span>
                  ) : null}
                </div>
                <Card>
                  <CardContent className="p-0">
                    <ul>
                      {section.lines.map((line) => (
                        <LineRow
                          key={line.code}
                          line={line}
                          expanded={expanded.has(line.code)}
                          onToggle={() => toggle(line.code)}
                          formatMoney={formatMoney}
                        />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </section>
            ))
          )}
        </div>
      ) : null}
    </ReportShell>
  );
}
