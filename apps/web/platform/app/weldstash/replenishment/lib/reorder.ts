/**
 * Reorder list logic: grouping by supplier, quantities and line values,
 * urgency, overstock, and the warnings shown before draft purchase orders are
 * created. Pure, so it is tested apart from the screen.
 */

import type { PlanUrgency, ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';
import { toNumber, toNumberOrNull } from '../../lib/numbers';

/** Days of cover above which an item counts as overstocked. */
export const OVERSTOCK_DAYS = 180;

/** The quantity to order for a row: the user's edit, else the suggestion. */
export function effectiveQuantity(plan: Pick<ReplenishmentPlan, 'id' | 'suggestedQty'>, edits: Readonly<Record<string, number>>): number {
  return edits[plan.id] ?? plan.suggestedQty;
}

/** What a row's quantity costs: quantity x the supplier's unit cost (0 when no cost is known). */
export function lineValue(plan: Pick<ReplenishmentPlan, 'unitCost'>, quantity: number): number {
  return Math.round(quantity * toNumber(plan.unitCost) * 100) / 100;
}

export interface SupplierGroup {
  /** Null: the plans that have no supplier. */
  supplierId: string | null;
  supplierName: string | null;
  plans: ReplenishmentPlan[];
}

/** Groups plans by supplier, in order of supplier name; plans without a supplier come last. */
export function groupBySupplier(plans: readonly ReplenishmentPlan[]): SupplierGroup[] {
  const groups = new Map<string | null, SupplierGroup>();
  for (const plan of plans) {
    const key = plan.supplierId ?? null;
    let group = groups.get(key);
    if (!group) {
      group = { supplierId: key, supplierName: key ? plan.supplierName : null, plans: [] };
      groups.set(key, group);
    }
    group.plans.push(plan);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.supplierId === null) return 1;
    if (b.supplierId === null) return -1;
    return (a.supplierName ?? '').localeCompare(b.supplierName ?? '');
  });
}

/**
 * How urgent a plan is, by the server's own rules: out of stock (nothing
 * available), will run out within the lead time, or within lead time plus the
 * review period. Null when none applies.
 */
export function urgencyOf(
  plan: Pick<ReplenishmentPlan, 'onHand' | 'allocated' | 'stockoutDate' | 'leadTimeDays' | 'reviewPeriodDays'>,
  today: string,
): PlanUrgency | null {
  if (plan.onHand - plan.allocated <= 0) return 'out_of_stock';
  if (!plan.stockoutDate) return null;
  const lead = plan.leadTimeDays ?? 0;
  if (plan.stockoutDate <= addDays(today, lead)) return 'lead_time';
  if (plan.stockoutDate <= addDays(today, lead + (plan.reviewPeriodDays ?? 0))) return 'review';
  return null;
}

/** `YYYY-MM-DD` plus days, in UTC. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today as `YYYY-MM-DD` in UTC, the plans' own calendar. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** More than `OVERSTOCK_DAYS` days of cover. */
export function isOverstock(plan: Pick<ReplenishmentPlan, 'daysOfCover'>): boolean {
  const cover = toNumberOrNull(plan.daysOfCover);
  return cover !== null && cover > OVERSTOCK_DAYS;
}

export type QuantityHint = 'below_minimum' | 'not_multiple';

/** A note for a quantity that does not fit the supplier's terms (the order still goes through). */
export function quantityHint(
  plan: Pick<ReplenishmentPlan, 'minOrderQty' | 'orderMultiple'>,
  quantity: number,
): QuantityHint | null {
  if (quantity <= 0) return null;
  if (plan.minOrderQty && quantity < plan.minOrderQty) return 'below_minimum';
  if (plan.orderMultiple && plan.orderMultiple > 1 && quantity % plan.orderMultiple !== 0) return 'not_multiple';
  return null;
}

export interface BelowMinimumWarning {
  supplierId: string;
  supplierName: string | null;
  total: number;
  minimum: number;
  currency: string | null;
}

export interface CreateWarnings {
  /** Selected plans that have no supplier: they are skipped. */
  withoutSupplier: ReplenishmentPlan[];
  /** Suppliers whose selected lines add up to less than their minimum order value. */
  belowMinimum: BelowMinimumWarning[];
  /** Plans whose quantity is zero: they are skipped. */
  zeroQuantity: ReplenishmentPlan[];
}

/**
 * Warnings for the selected rows. `minimumOrderValues` maps supplier id to
 * its minimum order value (numeric text from the supplier row, or a number).
 * Totals are per supplier across the selection, summed in the plan's own
 * currency (a mix of currencies for one supplier is not converted).
 */
export function createWarnings(
  selected: readonly ReplenishmentPlan[],
  edits: Readonly<Record<string, number>>,
  minimumOrderValues: Readonly<Record<string, string | number | null | undefined>>,
): CreateWarnings {
  const withoutSupplier: ReplenishmentPlan[] = [];
  const zeroQuantity: ReplenishmentPlan[] = [];
  const totals = new Map<string, { name: string | null; total: number; currency: string | null }>();

  for (const plan of selected) {
    if (!plan.supplierId) {
      withoutSupplier.push(plan);
      continue;
    }
    const quantity = effectiveQuantity(plan, edits);
    if (quantity <= 0) {
      zeroQuantity.push(plan);
      continue;
    }
    const entry = totals.get(plan.supplierId) ?? { name: plan.supplierName, total: 0, currency: plan.currency };
    entry.total += lineValue(plan, quantity);
    totals.set(plan.supplierId, entry);
  }

  const belowMinimum: BelowMinimumWarning[] = [];
  for (const [supplierId, entry] of totals) {
    const minimum = toNumber(minimumOrderValues[supplierId]);
    if (minimum > 0 && entry.total < minimum) {
      belowMinimum.push({
        supplierId,
        supplierName: entry.name,
        total: Math.round(entry.total * 100) / 100,
        minimum,
        currency: entry.currency,
      });
    }
  }
  return { withoutSupplier, belowMinimum, zeroQuantity };
}
