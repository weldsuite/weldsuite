import '@tanstack/react-start/server-only';

import { and, eq, ne } from 'drizzle-orm';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import type { AdminIdentity } from './auth';
import { consoleAuditRow } from './audit';
import { inMasterTransaction, masterSchema, type MasterDatabase } from './db';
import { adminCopy, fill } from './i18n';
import { generateId } from './id';
import { firstIssue, planCreateSchema, planUpdateSchema } from './plan-input';

/**
 * Plan saves on the Kubernetes editions: there is no Stripe and no billing
 * worker, so the console writes `plans` itself, with the billing worker's
 * rules (`plan-input.ts`) and its audit actions (`plan.create`,
 * `plan.update`). The platform and the pricing pages read the row.
 */

const { plans, adminAuditEvents } = masterSchema;

type Saved = { ok: true; data: { plan: { id: string }; stripeError: null } } | { ok: false; error: string };

/** One default plan at most: making one the default clears the others. */
async function clearOtherDefaults(tx: MasterDatabase, planId: string): Promise<void> {
  await tx
    .update(plans)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(plans.isDefault, true), ne(plans.id, planId)));
}

export async function createPlanDirect(identity: AdminIdentity, body: unknown, reason: string): Promise<Saved> {
  const parsed = planCreateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  return inMasterTransaction(async (tx) => {
    const [taken] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.slug, input.slug)).limit(1);
    if (taken) return { ok: false as const, error: fill(adminCopy().plans.errors.slugTaken, { slug: input.slug }) };
    const id = generateId('plan');
    await tx.insert(plans).values({
      id,
      ...input,
      currency: input.currency.toUpperCase(),
      features: input.features as PlanFeatures,
    });
    if (input.isDefault) await clearOtherDefaults(tx, id);
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity,
        action: 'plan.create',
        outcome: 'success',
        targetType: 'plan',
        workspaceId: null,
        targetId: id,
        reason,
        details: { input },
      }),
    );
    return { ok: true as const, data: { plan: { id }, stripeError: null } };
  });
}

export async function updatePlanDirect(
  identity: AdminIdentity,
  planId: string,
  body: unknown,
  reason: string,
): Promise<Saved> {
  const parsed = planUpdateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const patch = parsed.data;

  return inMasterTransaction(async (tx) => {
    const updated = await tx
      .update(plans)
      .set({
        ...patch,
        ...(patch.currency ? { currency: patch.currency.toUpperCase() } : {}),
        ...(patch.features ? { features: patch.features as PlanFeatures } : {}),
        updatedAt: new Date(),
      })
      .where(eq(plans.id, planId))
      .returning({ id: plans.id });
    if (updated.length === 0) return { ok: false as const, error: adminCopy().plans.errors.notFound };
    if (patch.isDefault) await clearOtherDefaults(tx, planId);
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity,
        action: 'plan.update',
        outcome: 'success',
        targetType: 'plan',
        workspaceId: null,
        targetId: planId,
        reason,
        details: { patch },
      }),
    );
    return { ok: true as const, data: { plan: { id: planId }, stripeError: null } };
  });
}
