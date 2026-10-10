/**
 * The per-stage calculation shown in the pipeline board's bottom bar (total,
 * average, weighted, ...).
 *
 * Only the calculation's *type* is saved in the pipeline's settings. The number
 * is computed from the deals on every render: a number saved as text ("€0")
 * went stale the moment a deal moved or was edited, and carried whatever
 * currency happened to be the pipeline default when it was picked.
 */

import {
  dominantCurrency,
  formatCurrencyTotals,
  sumByCurrency,
  type DealAmount,
} from '@/lib/crm/deal-format';
import type { StageCalculationSetting } from '@/app/weldcrm/pipeline/pipeline-settings-types';

export interface CalculationDeal {
  value: number;
  currency?: string | null;
}

export interface CalculationStage {
  id: string;
  /** 0-100, the stage's win probability. */
  probability?: number;
  deals: readonly CalculationDeal[];
}

export interface CalculationContext {
  /** The pipeline's default currency: for deals without one, and for an empty total. */
  defaultCurrency: string;
}

const MONEY_OPTIONS = { compactMillions: true } as const;

const asAmounts = (deals: readonly CalculationDeal[]): DealAmount[] =>
  deals.map((deal) => ({ amount: deal.value, currency: deal.currency }));

/**
 * Amounts per currency are never added across currencies: with deals in more
 * than one, each total is shown in its own currency ("€1,200 + $500"). An empty
 * stage shows its zero in the currency of the pipeline's other deals, so it
 * doesn't read "€0" next to "$6,100".
 */
function emptyCurrencyFor(stages: readonly CalculationStage[], { defaultCurrency }: CalculationContext): string {
  return dominantCurrency(
    stages.flatMap((stage) => stage.deals),
    defaultCurrency,
  );
}

function formatPerCurrency(
  deals: readonly CalculationDeal[],
  stages: readonly CalculationStage[],
  context: CalculationContext,
  perCurrency: (sum: number, count: number) => number,
): string {
  const sums = sumByCurrency(asAmounts(deals), context.defaultCurrency);
  const counts = sumByCurrency(
    deals.map((deal) => ({ amount: 1, currency: deal.currency })),
    context.defaultCurrency,
  );
  const result = new Map<string, number>();
  for (const [code, sum] of sums) result.set(code, perCurrency(sum, counts.get(code) ?? 0));
  return formatCurrencyTotals(result, emptyCurrencyFor(stages, context), MONEY_OPTIONS);
}

/** The text shown for `setting` on `stage`, computed from the stage's current deals. */
export function computeStageCalculation(
  setting: StageCalculationSetting,
  stage: CalculationStage,
  stages: readonly CalculationStage[],
  context: CalculationContext,
): string {
  switch (setting.type) {
    case 'total':
      return formatPerCurrency(stage.deals, stages, context, (sum) => sum);
    case 'average':
      return formatPerCurrency(stage.deals, stages, context, (sum, count) => (count > 0 ? sum / count : 0));
    case 'weighted':
      return formatPerCurrency(stage.deals, stages, context, (sum) => (sum * (stage.probability ?? 0)) / 100);
    case 'winRate':
      return `${stage.probability ?? 0}%`;
    case 'distribution': {
      // A share of the pipeline's value. Across several currencies a value
      // share is meaningless, so then it is the share of the deals.
      const all = stages.flatMap((s) => s.deals);
      const singleCurrency = sumByCurrency(asAmounts(all), context.defaultCurrency).size <= 1;
      const weigh = (deals: readonly CalculationDeal[]) =>
        singleCurrency ? deals.reduce((sum, deal) => sum + deal.value, 0) : deals.length;
      const whole = weigh(all);
      const share = whole > 0 ? (weigh(stage.deals) / whole) * 100 : 0;
      return `${share.toFixed(1)}%`;
    }
    case 'custom':
      // No formula evaluation yet: the formula text itself is what's shown.
      return setting.value === undefined || setting.value === '' ? '-' : String(setting.value);
    default:
      return '-';
  }
}

/**
 * Settings saved before only the type was stored carry a text `value` for every
 * type. Drop it for the computed ones so it can't be read (or written back).
 */
export function normalizeStageCalculations(
  saved: Record<string, StageCalculationSetting> | undefined,
): Record<string, StageCalculationSetting> {
  const normalized: Record<string, StageCalculationSetting> = {};
  for (const [stageId, setting] of Object.entries(saved ?? {})) {
    normalized[stageId] =
      setting.type === 'custom' ? { type: 'custom', value: setting.value } : { type: setting.type };
  }
  return normalized;
}
