import '@tanstack/react-start/server-only';

import { guardWrite, type AdminIdentity } from '@/lib/auth';
import { adminCopy } from '@/lib/i18n';
import { createPlanDirect, updatePlanDirect } from '@/lib/plans-direct';
import type { ActionResult } from './workspaces';

/**
 * Plan catalog changes. There is no Stripe: the console saves the row itself
 * (`lib/plans-direct.ts`).
 */

export interface PlanFormValues {
  name: string;
  description: string | null;
  priceMonthly: string;
  priceYearly: string;
  currency: string;
  pricePerUser: string | null;
  includedUsers: number | null;
  monthlyCredits: number;
  creditsRolloverCap: number | null;
  maxUsers: number | null;
  maxProjects: number | null;
  maxCustomDomains: number | null;
  removeBranding: boolean;
  hasApiAccess: boolean;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  badge: string | null;
  color: string | null;
  features: Record<string, unknown>;
}

export interface PlanSaveResult {
  plan: { id: string };
}

/** A plan save: a writer and a reason, then the direct write. */
async function directWrite(
  write: (ctx: { identity: AdminIdentity; reason: string }) => Promise<ActionResult<PlanSaveResult>>,
  reason: string,
): Promise<ActionResult<PlanSaveResult>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const trimmed = reason.trim();
  if (trimmed.length < 3) return { ok: false, error: adminCopy().staff.errors.reason };
  return write({ identity: guard.identity, reason: trimmed.slice(0, 500) });
}

export async function createPlan(input: PlanFormValues & { slug: string; reason: string }) {
  return directWrite(({ identity, reason }) => createPlanDirect(identity, input, reason), input.reason);
}

export async function updatePlan(planId: string, patch: Partial<PlanFormValues> & { reason: string }) {
  const { reason, ...fields } = patch;
  return directWrite((ctx) => updatePlanDirect(ctx.identity, planId, fields, ctx.reason), reason);
}
