/**
 * The WeldPanel price list at settlement: master `system_settings` row
 * `weldpanel.pricing`, edited in the admin console. Memo (per isolate) → KV
 * (shared, 60 s) → master DB, like WeldMeet's `getMeetingAiPricing`. A failed
 * lookup serves the defaults: a block must still be chargeable.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import {
  DEFAULT_PANEL_PRICING,
  PRICING_CACHE_TTL_SECONDS,
  WELDPANEL_PRICING_KEY,
  WELDPANEL_PRICING_KV_KEY,
  parsePanelPricing,
  type PanelPricing,
} from '@weldsuite/panel-domain/pricing';

let memo: { at: number; pricing: PanelPricing } | null = null;

/** Drops the per-isolate memo (tests, and callers that just changed the setting). */
export function resetPanelPricingMemo(): void {
  memo = null;
}

export async function getPanelPricing(masterDb: AnyMasterDatabase, kv?: Pick<KVNamespace, 'get' | 'put'>): Promise<PanelPricing> {
  const now = Date.now();
  if (memo && now - memo.at < PRICING_CACHE_TTL_SECONDS * 1000) return memo.pricing;

  try {
    const cached = kv ? await kv.get(WELDPANEL_PRICING_KV_KEY, 'json') : null;
    if (cached) {
      const pricing = parsePanelPricing(cached);
      memo = { at: now, pricing };
      return pricing;
    }
  } catch {
    // KV miss or outage: fall through to the database.
  }

  try {
    const [row] = await masterDb
      .select({ value: masterSchema.systemSettings.value })
      .from(masterSchema.systemSettings)
      .where(eq(masterSchema.systemSettings.key, WELDPANEL_PRICING_KEY))
      .limit(1);
    const pricing = parsePanelPricing(row?.value);
    memo = { at: now, pricing };
    try {
      await kv?.put(WELDPANEL_PRICING_KV_KEY, JSON.stringify(pricing), { expirationTtl: PRICING_CACHE_TTL_SECONDS });
    } catch {
      // The cache write is best effort.
    }
    return pricing;
  } catch (error) {
    console.warn('[panel-api] pricing lookup failed, using defaults:', error instanceof Error ? error.message : error);
    return { ...DEFAULT_PANEL_PRICING };
  }
}
