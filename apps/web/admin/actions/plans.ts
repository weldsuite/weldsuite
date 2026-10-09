'use server';

import { revalidatePath } from 'next/cache';
import { guardWrite } from '@/lib/auth';
import { callBillingWorker } from '@/lib/billing-worker';
import type { ActionResult } from './workspaces';

/**
 * Plan catalog changes. The billing worker saves the plan and brings its
 * Stripe product and prices in line (and audits it); a Stripe failure comes
 * back as `stripeError` next to the saved plan rather than as a failure.
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
  stripeError: string | null;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

async function planWrite<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<T>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: 'Invalid request id.' };

  const result = await callBillingWorker<T>(method, path, { identity: guard.identity, body, requestId });
  revalidatePath('/plans', 'layout');
  revalidatePath('/activity');
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

export async function createPlan(input: PlanFormValues & { slug: string; reason: string }, requestId: string) {
  return planWrite<PlanSaveResult>('POST', '/plans', { ...input }, requestId);
}

export async function updatePlan(
  planId: string,
  patch: Partial<PlanFormValues> & { reason: string },
  requestId: string,
) {
  return planWrite<PlanSaveResult>('PATCH', `/plans/${encodeURIComponent(planId)}`, { ...patch }, requestId);
}

export async function syncPlan(planId: string, input: { reason: string }, requestId: string) {
  return planWrite<{ changes: string[] }>('POST', `/plans/${encodeURIComponent(planId)}/sync`, input, requestId);
}
