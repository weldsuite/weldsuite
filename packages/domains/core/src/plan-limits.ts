/**
 * Plan limits: what a workspace's plan allows, read from a small table per
 * feature instead of one meter per feature.
 *
 * `@weldsuite/credits/meters` counts usage in a Durable Object and pays
 * overage from the wallet; that fits a few high-volume actions. Most limits
 * are simply "this many per month", counted from the module's own rows (WeldForms
 * counts completed responses). They only need the plan the workspace is on, and
 * that is what this file reads: the workspace's plan, else the default plan,
 * else none (the same order `loadMeterLimits` uses).
 *
 * A module keeps a table from plan slug to limit (`null` = unlimited) next to
 * its schemas and asks `planLimit(table, plan)`. WeldForms' is
 * `FORM_RESPONSE_QUOTAS` in `@weldsuite/app-api-client/schemas/weldforms`; WeldSign
 * can move its allowance here the same way.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';

const { plans, workspaces } = masterSchema;

export interface WorkspacePlan {
  /** `plans.id`; null for a workspace on no plan at all. */
  id: string | null;
  /** `plans.slug` (`free`, `starter`, …); null without a plan. */
  slug: string | null;
  name: string;
  features: PlanFeatures;
  /** Charges a price (monthly or per user): paid plans are never held to the free tier's numbers. */
  paid: boolean;
  /** The plan may switch off WeldSuite branding (`plans.removeBranding`). */
  removeBranding: boolean;
}

/** A module's limit per plan slug; `null` = unlimited. */
export type PlanLimitTable = Readonly<Record<string, number | null>>;

const NO_PLAN: WorkspacePlan = { id: null, slug: null, name: 'Free', features: {}, paid: false, removeBranding: false };

type PlanRow = typeof plans.$inferSelect;

function toPlan(row: PlanRow): WorkspacePlan {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    features: (row.features ?? {}) as PlanFeatures,
    paid: Number(row.priceMonthly ?? 0) > 0 || Number(row.pricePerUser ?? 0) > 0,
    removeBranding: row.removeBranding === true,
  };
}

/** The plan a workspace (`workspaces.id`) is on: its own, else the default plan, else none. */
export async function loadWorkspacePlan(master: AnyMasterDatabase, workspaceId: string): Promise<WorkspacePlan> {
  const [ws] = await master.select({ planId: workspaces.planId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const [own] = ws?.planId ? await master.select().from(plans).where(eq(plans.id, ws.planId)).limit(1) : [];
  if (own) return toPlan(own);
  const [fallback] = await master.select().from(plans).where(eq(plans.isDefault, true)).limit(1);
  return fallback ? toPlan(fallback) : NO_PLAN;
}

/**
 * The limit a plan gets from a module's table, `null` for unlimited.
 *
 * A slug in the table wins. A plan the table does not list is unlimited when it
 * is paid (a new paid plan must not fall back to the free tier's numbers), and
 * gets the `free` row otherwise (no plan, or a free custom plan).
 */
export function planLimit(table: PlanLimitTable, plan: Pick<WorkspacePlan, 'slug' | 'paid'>): number | null {
  if (plan.slug && Object.prototype.hasOwnProperty.call(table, plan.slug)) return table[plan.slug] ?? null;
  if (plan.paid) return null;
  return Object.prototype.hasOwnProperty.call(table, 'free') ? (table.free ?? null) : null;
}

/** The UTC calendar month containing `now`: `[start, end)`. */
export function utcMonthRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
