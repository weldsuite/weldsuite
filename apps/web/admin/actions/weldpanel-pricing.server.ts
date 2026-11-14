import '@tanstack/react-start/server-only';

import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { adminPanelPricingCopy, fill } from '@/lib/i18n';
import {
  MAX_CREDITS_PER_BLOCK,
  WELDPANEL_PRICING_KEY,
  parsePricingInput,
  type PanelPricing,
  type RateErrorCode,
} from '@/lib/weldpanel-pricing';

const { systemSettings } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function rateError(code: RateErrorCode): string {
  const copy = adminPanelPricingCopy();
  return code === 'out_of_range' ? fill(copy.rateOutOfRange, { max: MAX_CREDITS_PER_BLOCK }) : copy.invalidRate;
}

/**
 * Upsert the `weldpanel.pricing` system setting. panel-api caches the row for
 * about 60 s (KV + per-isolate memo) and cannot be invalidated from here, so a
 * change reaches new charges within a minute.
 */
export async function saveWeldpanelPricing(input: {
  eventsCreditsPer10k: string;
  recordingsCreditsPer100: string;
}): Promise<ActionResult<PanelPricing>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parsePricingInput(input);
  if (!parsed.ok) return { ok: false, error: rateError(parsed.code) };

  const copy = adminPanelPricingCopy();
  const value: PanelPricing = {
    eventsCreditsPer10k: parsed.data.eventsCreditsPer10k,
    recordingsCreditsPer100: parsed.data.recordingsCreditsPer100,
  };
  const updatedBy = guard.identity.email;

  try {
    await getMasterDb()
      .insert(systemSettings)
      .values({
        id: generateId('set'),
        key: WELDPANEL_PRICING_KEY,
        category: 'billing',
        dataType: 'json',
        value,
        description: 'WeldPanel overage: credits per 10,000 events and per 100 recordings beyond the plan allowance',
        updatedBy,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, category: 'billing', dataType: 'json', updatedBy, updatedAt: new Date() },
      });
  } catch {
    return { ok: false, error: copy.saveFailed };
  }

  return { ok: true, data: value };
}
