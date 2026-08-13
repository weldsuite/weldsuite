'use server';

import { revalidatePath } from 'next/cache';
import { RealtimeRegistrarError, missingDomainPricingFromPricelist } from '@weldsuite/realtime-registrar';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { getAdminRealtimeRegistrar } from '@/lib/realtime-registrar';
import { listExistingDomainTlds } from '@/lib/domain-pricing-data';

const { hostDomainPricing } = masterSchema;

const INSERT_CHUNK = 80;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface BackfillDomainPricingResult {
  fetched: number;
  inserted: number;
  skipped: number;
}

export async function backfillDomainPricing(): Promise<ActionResult<BackfillDomainPricingResult>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const rtr = getAdminRealtimeRegistrar();
  if (!rtr) {
    return {
      ok: false,
      error:
        'Realtime Register is not configured. Set REALTIME_REGISTER_API_KEY and REALTIME_REGISTER_CUSTOMER on the admin app.',
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
          : 'Realtime Register pricelist request failed';
    return { ok: false, error: message };
  }

  const existing = await listExistingDomainTlds();
  const missing = missingDomainPricingFromPricelist(wholesale, existing);
  if (missing.length === 0) {
    revalidatePath('/domain-pricing');
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

  revalidatePath('/domain-pricing');
  revalidatePath('/');
  return {
    ok: true,
    data: {
      fetched: wholesale.size,
      inserted,
      skipped: wholesale.size - inserted,
    },
  };
}
