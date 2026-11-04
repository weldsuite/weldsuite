/** The six figures at the top of Finance: budget, actual, committed, forecast, CPI and SPI. */

import type { ProjectFinance } from '@weldsuite/app-api-client/domains/project-finance';
import { formatMoney, formatPercent, formatRatio } from '../_lib/finance';
import { Tile, useFinanceEnv } from './finance-parts';

/** Amounts, or the percentage of the budget for a caller without finance rights. */
function figure(finance: ProjectFinance, amount: string | null, percent: number | null, intlLocale: string): string {
  if (finance.canSeeAmounts) return formatMoney(amount, finance.currency, intlLocale);
  return percent === null ? '–' : `${formatPercent(percent, intlLocale)}%`;
}

export function KpiStrip({ finance }: Readonly<{ finance: ProjectFinance }>) {
  const { copy, format, intlLocale } = useFinanceEnv();
  const k = copy.overview.kpi;
  const { figures, percent } = finance;

  const forecastNumber = figures.forecast === null ? null : Number(figures.forecast);
  const budgetNumber = figures.budget === null ? null : Number(figures.budget);
  const over = forecastNumber !== null && budgetNumber !== null && forecastNumber > budgetNumber;
  const variancePercent = percent.forecast === null ? null : Math.abs(percent.forecast - 100);

  let forecastNote: string | undefined;
  if (figures.forecastSource === 'manual') forecastNote = k.forecastManual;
  else if (percent.forecast !== null) {
    const amount = finance.canSeeAmounts
      ? formatMoney(String(Math.abs(Number(figures.variance ?? 0))), finance.currency, intlLocale)
      : `${formatPercent(variancePercent, intlLocale)}%`;
    const text = { amount, percent: formatPercent(variancePercent, intlLocale) };
    if (percent.forecast > 100) forecastNote = format(k.forecastOver, text);
    else if (percent.forecast < 100) forecastNote = format(k.forecastUnder, text);
    else forecastNote = k.forecastOn;
  }

  const spiPercent = figures.spi === null ? null : Math.round(figures.spi * 100);
  const lowCpi = figures.cpi !== null && figures.cpi < 1;
  const lowSpi = figures.spi !== null && figures.spi < 1;

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
        note={percent.spent === null ? undefined : format(k.actualNote, { percent: formatPercent(percent.spent, intlLocale) })}
      />
      <Tile
        label={k.committed}
        value={figure(finance, figures.committed, percent.committed, intlLocale)}
        note={percent.committed === null ? undefined : format(k.committedNote, { percent: formatPercent(percent.committed, intlLocale) })}
      />
      <Tile
        label={k.forecast}
        value={figure(finance, figures.forecast, percent.forecast, intlLocale)}
        note={forecastNote}
        tone={over ? 'warning' : 'default'}
      />
      <Tile
        label={k.cpi}
        value={formatRatio(figures.cpi, intlLocale)}
        note={figures.cpi === null ? k.cpiNone : format(k.cpiNote, { value: formatRatio(figures.cpi, intlLocale) })}
        tone={lowCpi ? 'warning' : 'default'}
      />
      <Tile
        label={k.spi}
        value={formatRatio(figures.spi, intlLocale)}
        note={spiPercent === null ? k.spiNone : format(k.spiNote, { percent: formatPercent(spiPercent, intlLocale) })}
        tone={lowSpi ? 'warning' : 'default'}
      />
    </div>
  );
}

function shortDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short' }).format(new Date(iso));
}
