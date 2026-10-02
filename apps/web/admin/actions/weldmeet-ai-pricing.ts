'use server';

import { revalidatePath } from 'next/cache';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { adminMeetAiPricingCopy, fill } from '@/lib/i18n';
import {
  MAX_CREDITS_PER_MINUTE,
  WELDMEET_AI_PRICING_KEY,
  parsePricingInput,
  type RateErrorCode,
  type WeldmeetAiPricing,
} from '@/lib/weldmeet-ai-pricing';

const { systemSettings } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function rateError(code: RateErrorCode): string {
  const copy = adminMeetAiPricingCopy();
  if (code === 'out_of_range') return fill(copy.rateOutOfRange, { max: MAX_CREDITS_PER_MINUTE });
  if (code === 'decimals') return copy.rateDecimals;
  return copy.invalidRate;
}

/**
 * Upsert the `weldmeet.ai_pricing` system setting. meet-api caches the row for
 * about 60 s (KV + per-isolate memo) and cannot be invalidated from here, so a
 * change reaches new charges within a minute.
 */
export async function saveWeldmeetAiPricing(input: {
  transcriptionCreditsPerMinute: string;
  summaryCreditsPerMinute: string;
}): Promise<ActionResult<WeldmeetAiPricing>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = parsePricingInput(input);
  if (!parsed.ok) return { ok: false, error: rateError(parsed.code) };

  const copy = adminMeetAiPricingCopy();
  const value: WeldmeetAiPricing = {
    transcriptionCreditsPerMinute: parsed.data.transcriptionCreditsPerMinute,
    summaryCreditsPerMinute: parsed.data.summaryCreditsPerMinute,
  };
  const updatedBy = guard.identity.email;

  try {
    await getMasterDb()
      .insert(systemSettings)
      .values({
        id: generateId('set'),
        key: WELDMEET_AI_PRICING_KEY,
        category: 'billing',
        dataType: 'json',
        value,
        description: 'WeldMeet AI credits per meeting minute (transcript and summary)',
        updatedBy,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, category: 'billing', dataType: 'json', updatedBy, updatedAt: new Date() },
      });
  } catch {
    return { ok: false, error: copy.saveFailed };
  }

  revalidatePath('/weldmeet-ai-pricing');
  return { ok: true, data: value };
}
