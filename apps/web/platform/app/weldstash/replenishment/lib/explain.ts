/**
 * The plain sentence that explains a reorder suggestion, built from a plan's
 * numbers: "Reorder at 140: 20 days' lead time at 5.2 a day is 104, plus 36
 * safety stock for 95% availability."
 *
 * Pure: the wording comes in as templates (from the locale module), so the
 * builder is tested apart from React and works in both languages.
 */

import { toNumber, toNumberOrNull } from '../../lib/numbers';

/** The plan fields the sentence reads (a `ReplenishmentPlan` satisfies it). */
export interface ExplainInput {
  method: string;
  confidence: string;
  reorderPoint: number | null;
  orderUpTo: number | null;
  safetyStock: number | null;
  leadTimeDays: number | null;
  avgDailyDemand: string | number | null;
  serviceLevel: string | number | null;
  onHand: number;
  allocated: number;
  incoming: number;
  inventoryPosition: number;
  suggestedQty: number;
}

/** Templates with `{name}` placeholders. */
export interface ExplainTexts {
  /** The item's rule is off. */
  off: string;
  /** No usable demand history and no min/max rule. */
  noData: string;
  /** `{reorderPoint}`, `{min}`, `{max}`. */
  minMax: string;
  /** `{reorderPoint}`, `{leadTime}`, `{perDay}`, `{leadDemand}`, `{safetyStock}`, `{service}`. */
  statistical: string;
  /** `{onHand}`, `{allocated}`, `{incoming}`, `{position}`. */
  position: string;
  /** `{quantity}`, `{orderUpTo}`. */
  order: string;
  nothingToOrder: string;
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/** One decimal, no trailing zero: 5.2, 5, 0.3. */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** A service level 0.95 as `95`, 0.995 as `99.5`. */
function percent(level: number): string {
  return oneDecimal(level * 100);
}

export function buildExplanation(plan: ExplainInput, texts: ExplainTexts): string {
  if (plan.method === 'none') {
    return plan.confidence === 'none' ? texts.noData : texts.off;
  }
  const reorderPoint = plan.reorderPoint;
  if (reorderPoint === null) return texts.noData;

  const parts: string[] = [];
  if (plan.method === 'min_max') {
    parts.push(
      fill(texts.minMax, { reorderPoint, min: reorderPoint, max: plan.orderUpTo ?? reorderPoint }),
    );
  } else {
    const perDay = toNumber(plan.avgDailyDemand);
    const leadTime = plan.leadTimeDays ?? 0;
    const safetyStock = plan.safetyStock ?? 0;
    // The point is the demand over the lead time plus safety stock; read the
    // first part off the stored point, so the sentence always adds up.
    const leadDemand = reorderPoint - safetyStock;
    parts.push(
      fill(texts.statistical, {
        reorderPoint,
        leadTime,
        perDay: oneDecimal(perDay),
        leadDemand,
        safetyStock,
        service: percent(toNumberOrNull(plan.serviceLevel) ?? 0),
      }),
    );
  }

  parts.push(
    fill(texts.position, {
      onHand: plan.onHand,
      allocated: plan.allocated,
      incoming: plan.incoming,
      position: plan.inventoryPosition,
    }),
    plan.suggestedQty > 0
      ? fill(texts.order, { quantity: plan.suggestedQty, orderUpTo: plan.orderUpTo ?? plan.inventoryPosition + plan.suggestedQty })
      : texts.nothingToOrder,
  );
  return parts.join(' ');
}
