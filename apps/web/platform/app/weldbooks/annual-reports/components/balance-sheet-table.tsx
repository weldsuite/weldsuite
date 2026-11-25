/**
 * The balance sheet of an annual report as an editable two-column table: this
 * year and the prior year (which can be cleared for a first filing). Totals are
 * computed from what is typed in; the ledger accounts behind each line open
 * under it. Semantic table with row and column headers, scrollable on a phone.
 */

import { Fragment, useId, useState } from 'react';
import { Controller, useWatch, type Control, type UseFormSetValue } from 'react-hook-form';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  ASSET_CURRENT_LINES,
  ASSET_FIXED_LINES,
  EQUITY_LINES,
  accountsForLine,
  annualReportTotals,
  balanceDifference,
  isBalanced,
  type AnnualReport,
  type AnnualReportLineKey,
  type AnnualReportTotals,
  type TotalKey,
} from '@/lib/weldbooks/annual-report-model';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { normalizeLines, type AnnualReportFormValues } from '../annual-report-form';

interface Group {
  lines: readonly AnnualReportLineKey[];
  total?: TotalKey;
}

const ASSETS: readonly Group[] = [
  { lines: ASSET_FIXED_LINES, total: 'fixedAssets' },
  { lines: ASSET_CURRENT_LINES, total: 'currentAssets' },
];
const EQUITY_AND_LIABILITIES: readonly Group[] = [
  { lines: EQUITY_LINES, total: 'equity' },
  { lines: ['provisions'] },
  { lines: ['longTermLiabilities', 'currentLiabilities'], total: 'liabilities' },
];

const AMOUNT = 'w-full min-w-[8rem] text-right tabular-nums';

export function BalanceSheetTable({
  report,
  control,
  setValue,
  editable,
}: Readonly<{
  report: AnnualReport;
  control: Control<AnnualReportFormValues>;
  setValue: UseFormSetValue<AnnualReportFormValues>;
  editable: boolean;
}>) {
  const { t } = useI18n();
  const tb = t.weldbooksNl.annualReports.balance;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const captionId = useId();
  const [open, setOpen] = useState<ReadonlySet<AnnualReportLineKey>>(new Set());

  const current = useWatch({ control, name: 'current' });
  const prior = useWatch({ control, name: 'prior' });
  const hasPrior = useWatch({ control, name: 'hasPrior' });
  const sizeClass = useWatch({ control, name: 'sizeClass' });

  const currentLines = normalizeLines(current);
  const priorLines = normalizeLines(prior);
  const currentTotals = annualReportTotals(currentLines);
  const priorTotals: AnnualReportTotals | null = hasPrior ? annualReportTotals(priorLines) : null;
  const year = report.fiscalYear;

  const toggle = (key: AnnualReportLineKey) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const amountInput = (field: 'current' | 'prior', key: AnnualReportLineKey, yearLabel: number) => (
    <Controller
      control={control}
      name={`${field}.${key}`}
      render={({ field: f }) => (
        <NumberInput
          className={AMOUNT}
          step="0.01"
          disabled={!editable}
          aria-label={tb.amountLabel.replace('{line}', tb.lines[key]).replace('{year}', String(yearLabel))}
          value={f.value}
          onValueChange={f.onChange}
          onBlur={f.onBlur}
          name={f.name}
          ref={f.ref}
        />
      )}
    />
  );

  const renderLine = (key: AnnualReportLineKey) => {
    const accounts = accountsForLine(report, key);
    const expanded = open.has(key);
    const panelId = `${captionId}-${key}`;
    return (
      <Fragment key={key}>
        <tr className="border-b border-border/60">
          <th scope="row" className="py-1.5 pr-3 text-left text-sm font-normal">
            <span className="flex items-center gap-1">
              {accounts.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  aria-label={(expanded ? tb.hideAccounts : tb.showAccounts)
                    .replace('{count}', String(accounts.length))
                    .replace('{line}', tb.lines[key])}
                  onClick={() => toggle(key)}
                >
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </Button>
              ) : (
                <span className="inline-block size-6" aria-hidden="true" />
              )}
              {tb.lines[key]}
            </span>
          </th>
          <td className="px-1 py-1">{amountInput('current', key, year)}</td>
          <td className="px-1 py-1">{hasPrior ? amountInput('prior', key, year - 1) : <span className="block text-right text-muted-foreground">—</span>}</td>
        </tr>
        {expanded
          ? accounts.map((account, index) => (
              <tr key={`${account.accountId ?? index}`} id={index === 0 ? panelId : undefined} className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
                <th scope="row" className="py-1 pl-9 pr-3 text-left font-normal">
                  {[account.code, account.name].filter(Boolean).join(' ')}
                </th>
                <td className="px-3 py-1 text-right tabular-nums">{formatMoney(account.current)}</td>
                <td className="px-3 py-1 text-right tabular-nums">{account.prior === null ? '—' : formatMoney(account.prior)}</td>
              </tr>
            ))
          : null}
      </Fragment>
    );
  };

  const totalRow = (label: string, key: TotalKey, strong = false) => (
    <tr key={key} className={cn('border-b border-border', strong ? 'bg-muted/50 font-semibold' : 'font-medium')}>
      <th scope="row" className="py-1.5 pr-3 text-left text-sm font-[inherit]">
        <span className="pl-7">{label}</span>
      </th>
      <td className="px-3 py-1.5 text-right text-sm tabular-nums">{formatMoney(currentTotals[key])}</td>
      <td className="px-3 py-1.5 text-right text-sm tabular-nums">{priorTotals ? formatMoney(priorTotals[key]) : '—'}</td>
    </tr>
  );

  const section = (title: string, groups: readonly Group[], grand: TotalKey) => (
    <tbody key={grand}>
      <tr>
        <th scope="rowgroup" colSpan={3} className="pt-4 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </th>
      </tr>
      {groups.map((group) => (
        <Fragment key={group.lines[0]}>
          {group.lines.map(renderLine)}
          {group.total ? totalRow(tb.totals[group.total as keyof typeof tb.totals], group.total) : null}
        </Fragment>
      ))}
      {totalRow(tb.totals[grand as keyof typeof tb.totals], grand, true)}
    </tbody>
  );

  const unbalanced: Array<{ year: number; difference: number }> = [];
  if (!isBalanced(currentLines)) unbalanced.push({ year, difference: balanceDifference(currentLines) });
  if (hasPrior && !isBalanced(priorLines)) unbalanced.push({ year: year - 1, difference: balanceDifference(priorLines) });

  return (
    <div className="space-y-3">
      {sizeClass === 'micro' ? <InfoBanner variant="neutral">{tb.microNote}</InfoBanner> : null}

      {/* A scrollable region must be focusable so keyboard users can scroll it (Modern Web Guidance: responsive table). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div role="region" aria-labelledby={captionId} tabIndex={0} className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[34rem] border-separate border-spacing-0">
          <caption id={captionId} className="sr-only">
            {tb.caption}
          </caption>
          <thead className="sticky top-0 z-[1] bg-background">
            <tr className="border-b">
              <th scope="col" className="py-2 pl-3 pr-3 text-left text-xs font-medium text-muted-foreground">
                {tb.line}
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                {tb.thisYear.replace('{year}', String(year))}
              </th>
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">
                {tb.priorYear.replace('{year}', String(year - 1))}
              </th>
            </tr>
          </thead>
          {section(tb.assets, ASSETS, 'assets')}
          {section(tb.equityAndLiabilities, EQUITY_AND_LIABILITIES, 'equityAndLiabilities')}
        </table>
      </div>

      {unbalanced.map(({ year: y, difference }) => (
        <InfoBanner key={y} variant="warning">
          {(unbalanced.length > 1 ? `${y}: ` : '') + tb.unbalanced.replace('{amount}', formatMoney(difference))}
        </InfoBanner>
      ))}
      {unbalanced.length === 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          {tb.balanced}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {report.figures.computedAt ? <p>{tb.computedAt.replace('{date}', formatDate(report.figures.computedAt))}</p> : null}
          {report.figures.edited ? <p>{tb.edited}</p> : null}
          {!hasPrior ? <p>{tb.noPrior}</p> : null}
        </div>
        {editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setValue('hasPrior', !hasPrior, { shouldDirty: true })}
          >
            {hasPrior ? tb.firstFiling : tb.addPrior}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
