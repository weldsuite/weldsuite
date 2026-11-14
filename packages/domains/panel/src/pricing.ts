/**
 * WeldPanel overage prices: the master `system_settings` row
 * `weldpanel.pricing` (category `billing`, JSON), edited in the admin console
 * and read by panel-api at settlement. The same shape as WeldMeet's
 * `weldmeet.ai_pricing`; defaults apply while the row is absent or a field is
 * invalid. The rates are placeholders until the wallet pricing is set.
 *
 * Pure: no database or binding here, so the admin console can share the key,
 * the rules and the defaults.
 */

export const WELDPANEL_PRICING_KEY = 'weldpanel.pricing';
/** KV cache of the row in panel-api, and the longest a price change takes to reach settlement. */
export const WELDPANEL_PRICING_KV_KEY = 'weldpanel-pricing';
export const PRICING_CACHE_TTL_SECONDS = 60;
/** Upper bound of a rate, credits per block. */
export const MAX_CREDITS_PER_BLOCK = 100_000;

export interface PanelPricing {
  /** Credits per 10,000 events beyond the allowance. */
  eventsCreditsPer10k: number;
  /** Credits per 100 recordings beyond the allowance. */
  recordingsCreditsPer100: number;
}

/** Placeholders (1 credit = 0.01): 10 credits per 10,000 events, 20 per 100 recordings. */
export const DEFAULT_PANEL_PRICING: PanelPricing = { eventsCreditsPer10k: 10, recordingsCreditsPer100: 20 };

/** A rate is a positive whole number of credits, at most {@link MAX_CREDITS_PER_BLOCK}: a block is charged in whole credits. */
export function isValidPanelRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_CREDITS_PER_BLOCK;
}

/** Validates a stored value; every missing or invalid field falls back to its default. */
export function parsePanelPricing(value: unknown, defaults: PanelPricing = DEFAULT_PANEL_PRICING): PanelPricing {
  if (!value || typeof value !== 'object') return { ...defaults };
  const v = value as Record<string, unknown>;
  return {
    eventsCreditsPer10k: isValidPanelRate(v.eventsCreditsPer10k) ? v.eventsCreditsPer10k : defaults.eventsCreditsPer10k,
    recordingsCreditsPer100: isValidPanelRate(v.recordingsCreditsPer100) ? v.recordingsCreditsPer100 : defaults.recordingsCreditsPer100,
  };
}
