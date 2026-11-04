/** The six figures at the top of Finance: budget, actual, committed, forecast, CPI and SPI. */

import type { ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { formatMoney, formatPercent, formatRatio } from '../_lib/finance';
import { Tile, useFinanceEnv } from './finance-parts';

/** Amounts, or the percentage of the budget for a caller without finance rights. */
function figure(finance: ProjectFinance, amount: string | null, percent: number | null, intlLocale: string): string {
  if (finance.canSeeAmounts) return formatMoney(amount, finance.currency, intlLocale);
  return percent === null ? '–' : `${formatPercent(percent, intlLocale)}%`;
}

type FinanceEnv = ReturnType<typeof useFinanceEnv>;

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function isOverBudget(figures: ProjectFinance['figures']): boolean {
  const forecast = toNumberOrNull(figures.forecast);
  const budget = toNumberOrNull(figures.budget);
  return forecast !== null && budget !== null && forecast > budget;
}

function isBelowOne(value: number | null): boolean {
  return value !== null && value < 1;
}

function toneOf(warning: boolean): 'warning' | 'default' {
  return warning ? 'warning' : 'default';
}

function percentNote(percent: number | null, template: string, env: FinanceEnv): string | undefined {
  return percent === null ? undefined : env.format(template, { percent: formatPercent(percent, env.intlLocale) });
}

function forecastNoteOf(finance: ProjectFinance, env: FinanceEnv): string | undefined {
  const { figures, percent } = finance;
  const k = env.copy.overview.kpi;
  if (figures.forecastSource === 'manual') return k.forecastManual;
  if (percent.forecast === null) return undefined;
  const variancePercent = Math.abs(percent.forecast - 100);
  const amount = finance.canSeeAmounts
    ? formatMoney(String(Math.abs(Number(figures.variance ?? 0))), finance.currency, env.intlLocale)
    : `${formatPercent(variancePercent, env.intlLocale)}%`;
  const text = { amount, percent: formatPercent(variancePercent, env.intlLocale) };
  if (percent.forecast > 100) return env.format(k.forecastOver, text);
  if (percent.forecast < 100) return env.format(k.forecastUnder, text);
  return k.forecastOn;
}

export function KpiStrip({ finance }: Readonly<{ finance: ProjectFinance }>) {
  const env = useFinanceEnv();
  const { copy, format, intlLocale } = env;
  const k = copy.overview.kpi;
  const { figures, percent } = finance;
  const spiPercent = figures.spi === null ? null : Math.round(figures.spi * 100);

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr))]">
      <Tile
        label={k.budget}
        value={figure(finance, figures.budget, percent.spent === null ? null : 100, intlLocale)}
        note={finance.baseline ? format(k.budgetNote, { version: finance.baseline.version, date: shortDate(finance.baseline.createdAt, intlLocale) }) : k.budgetNoteNone}
      />
      <Tile
        label={k.actual}
        value={figure(finance, figures.actual, percent.spent, intlLocale)}
        note={percentNote(percent.spent, k.actualNote, env)}
      />
      <Tile
        label={k.committed}
        value={figure(finance, figures.committed, percent.committed, intlLocale)}
        note={percentNote(percent.committed, k.committedNote, env)}
      />
      <Tile
        label={k.forecast}
        value={figure(finance, figures.forecast, percent.forecast, intlLocale)}
        note={forecastNoteOf(finance, env)}
        tone={toneOf(isOverBudget(figures))}
      />
      <Tile
        label={k.cpi}
        value={formatRatio(figures.cpi, intlLocale)}
        note={figures.cpi === null ? k.cpiNone : format(k.cpiNote, { value: formatRatio(figures.cpi, intlLocale) })}
        tone={toneOf(isBelowOne(figures.cpi))}
      />
      <Tile
        label={k.spi}
        value={formatRatio(figures.spi, intlLocale)}
        note={spiPercent === null ? k.spiNone : format(k.spiNote, { percent: formatPercent(spiPercent, intlLocale) })}
        tone={toneOf(isBelowOne(figures.spi))}
      />
    </div>
  );
}

function shortDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short' }).format(new Date(iso));
}
