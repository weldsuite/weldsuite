'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { RealtimeRegistrarError, missingDomainPricingFromPricelist } from '@weldsuite/realtime-registrar';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { getAdminRealtimeRegistrar } from '@/lib/realtime-registrar';
import { listExistingDomainTlds } from '@/lib/domain-pricing-data';
import { adminPricingCopy } from '@/lib/i18n';
import { parseMarkupInput, type MarkupPatch } from '@/lib/domain-pricing-markup';

const { hostDomainPricing } = masterSchema;

const INSERT_CHUNK = 80;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface BackfillDomainPricingResult {
  fetched: number;
  inserted: number;
  skipped: number;
}

function refreshPricingRoutes(): void {
  revalidatePath('/domain-pricing');
  revalidatePath('/');
}

function markupError(code: 'invalid' | 'out_of_range'): string {
  const copy = adminPricingCopy();
  return code === 'out_of_range' ? copy.markupOutOfRange : copy.markupInvalid;
}

async function persistMarkup(
  patch: MarkupPatch,
  opts: { id?: string; onlyEmpty?: boolean } = {},
): Promise<number> {
  const db = getMasterDb();
  const values = {
    markupAmount: patch.markupAmount,
    markupPercent: patch.markupPercent,
    updatedAt: new Date(),
  };

  if (opts.id) {
    const updated = await db
      .update(hostDomainPricing)
      .set(values)
      .where(eq(hostDomainPricing.id, opts.id))
      .returning({ id: hostDomainPricing.id });
    return updated.length;
  }

  if (opts.onlyEmpty) {
    const updated = await db
      .update(hostDomainPricing)
      .set(values)
      .where(
        and(isNull(hostDomainPricing.markupAmount), isNull(hostDomainPricing.markupPercent)),
      )
      .returning({ id: hostDomainPricing.id });
    return updated.length;
  }

  const updated = await db
    .update(hostDomainPricing)
    .set(values)
    .returning({ id: hostDomainPricing.id });
  return updated.length;
}

export async function backfillDomainPricing(): Promise<ActionResult<BackfillDomainPricingResult>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const rtr = getAdminRealtimeRegistrar();
  if (!rtr) {
    return {
      ok: false,
      error: adminPricingCopy().notConfigured,
    };
  }

  let wholesale;
  try {
    wholesale = await rtr.getPricelist('EUR');
  } catch (err) {
    const message =
      err instanceof RealtimeRegistrarError
        ? err.message
        : err instanceof Error
          ? err.message
          : adminPricingCopy().pricelistFailed;
    return { ok: false, error: message };
  }

  const existing = await listExistingDomainTlds();
  const missing = missingDomainPricingFromPricelist(wholesale, existing);
  if (missing.length === 0) {
    refreshPricingRoutes();
    return {
      ok: true,
      data: { fetched: wholesale.size, inserted: 0, skipped: wholesale.size },
    };
  }

  const db = getMasterDb();
  let inserted = 0;

  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK).map((row) => ({
      id: generateId('dp'),
      tld: row.tld,
      category: row.isPopular ? 'popular' : null,
      registrationPrice: row.registrationPrice,
      renewalPrice: row.renewalPrice,
      transferPrice: row.transferPrice,
      currency: row.currency,
      isActive: true,
      isPopular: row.isPopular,
      registrar: row.registrar,
    }));
    const created = await db
      .insert(hostDomainPricing)
      .values(chunk)
      .onConflictDoNothing({ target: hostDomainPricing.tld })
      .returning({ tld: hostDomainPricing.tld });
    inserted += created.length;
  }

  refreshPricingRoutes();
  return {
    ok: true,
    data: {
      fetched: wholesale.size,
      inserted,
      skipped: wholesale.size - inserted,
    },
  };
}

export async function updateDomainPricingMarkup(
  id: string,
  input: { kind: string; value: string },
): Promise<ActionResult<{ id: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parseMarkupInput(input.kind, input.value);
  if (!parsed.ok) return { ok: false, error: markupError(parsed.code) };

  const updated = await persistMarkup(parsed.data, { id });
  if (!updated) return { ok: false, error: adminPricingCopy().markupNotFound };

  refreshPricingRoutes();
  return { ok: true, data: { id } };
}

export async function applyDomainPricingMarkup(input: {
  kind: string;
  value: string;
  onlyEmpty?: boolean;
}): Promise<ActionResult<{ updated: number }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parseMarkupInput(input.kind, input.value);
  if (!parsed.ok) return { ok: false, error: markupError(parsed.code) };

  const updated = await persistMarkup(parsed.data, { onlyEmpty: Boolean(input.onlyEmpty) });
  refreshPricingRoutes();
  return { ok: true, data: { updated } };
}
