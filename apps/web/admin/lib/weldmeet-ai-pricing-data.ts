import 'server-only';

import { eq } from 'drizzle-orm';
import { SERVICE_CREDIT_RATES } from '@weldsuite/credits';
import { getMasterDb, masterSchema } from './db';
import {
  WELDMEET_AI_PRICING_KEY,
  resolveStoredPricing,
  type WeldmeetAiPricing,
} from './weldmeet-ai-pricing';

const { systemSettings } = masterSchema;

export interface WeldmeetAiPricingView {
  /** Rates meet-api charges right now (saved row, or the defaults). */
  effective: WeldmeetAiPricing;
  /** Built-in defaults from `SERVICE_CREDIT_RATES`, used when the row is absent. */
  defaults: WeldmeetAiPricing;
  /** True when a `weldmeet.ai_pricing` row exists. */
  isCustom: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function weldmeetAiPricingDefaults(): WeldmeetAiPricing {
  return {
    transcriptionCreditsPerMinute: SERVICE_CREDIT_RATES.meetingTranscriptionPerMinute,
    summaryCreditsPerMinute: SERVICE_CREDIT_RATES.meetingSummaryPerMinute,
  };
}

export async function getWeldmeetAiPricing(): Promise<WeldmeetAiPricingView> {
  const defaults = weldmeetAiPricingDefaults();
  const db = getMasterDb();
  const [row] = await db
    .select({
      value: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
      updatedBy: systemSettings.updatedBy,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, WELDMEET_AI_PRICING_KEY))
    .limit(1);

  return {
    effective: resolveStoredPricing(row?.value, defaults),
    defaults,
    isCustom: Boolean(row),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy ?? null,
  };
}
