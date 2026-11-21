import { z } from 'zod';
import {
  DEFAULT_PANEL_PRICING,
  MAX_CREDITS_PER_BLOCK,
  WELDPANEL_PRICING_KEY,
  parsePanelPricing,
  type PanelPricing,
} from '@weldsuite/panel-domain/pricing';

/**
 * WeldPanel pricing: shared (server + client) validation for the
 * `weldpanel.pricing` system setting. The key, the shape, the bound and the
 * defaults come from `@weldsuite/panel-domain/pricing`, the same module
 * panel-api reads the row through at settlement.
 */

export { DEFAULT_PANEL_PRICING, MAX_CREDITS_PER_BLOCK, WELDPANEL_PRICING_KEY, type PanelPricing };

/** An example month over the allowance, shown on the page. */
export const EXAMPLE_EVENTS = 100_000;
export const EXAMPLE_RECORDINGS = 1_000;
const EVENT_BLOCK = 10_000;
const RECORDING_BLOCK = 100;

export type RateErrorCode = 'invalid' | 'out_of_range';

const rateSchema = z
  .number()
  .int({ message: 'invalid' })
  .gt(0, { message: 'invalid' })
  .max(MAX_CREDITS_PER_BLOCK, { message: 'out_of_range' });

const pricingSchema = z.object({
  eventsCreditsPer10k: rateSchema,
  recordingsCreditsPer100: rateSchema,
});

/** Parse form text; anything that is not a finite number becomes NaN. */
export function parseRateInput(raw: string): number {
  const normalized = raw.trim();
  if (!normalized) return Number.NaN;
  return Number(normalized);
}

export type PricingParseResult =
  | { ok: true; data: PanelPricing }
  | { ok: false; field: keyof PanelPricing; code: RateErrorCode };

/** Validate the two raw form values. Reports the first failing field. */
export function parsePricingInput(input: { eventsCreditsPer10k: string; recordingsCreditsPer100: string }): PricingParseResult {
  const result = pricingSchema.safeParse({
    eventsCreditsPer10k: parseRateInput(input.eventsCreditsPer10k),
    recordingsCreditsPer100: parseRateInput(input.recordingsCreditsPer100),
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const field = issue?.path[0] === 'recordingsCreditsPer100' ? 'recordingsCreditsPer100' : 'eventsCreditsPer10k';
  return { ok: false, field, code: issue?.message === 'out_of_range' ? 'out_of_range' : 'invalid' };
}

/** Effective pricing for a stored value: every missing or invalid field falls back to its default, as panel-api does. */
export function resolveStoredPricing(value: unknown): PanelPricing {
  return parsePanelPricing(value, DEFAULT_PANEL_PRICING);
}

/** Credits for an example month, per meter and in total (blocks round up, as at settlement). */
export function exampleCharge(pricing: PanelPricing): { events: number; recordings: number; total: number } {
  const events = Math.ceil(EXAMPLE_EVENTS / EVENT_BLOCK) * pricing.eventsCreditsPer10k;
  const recordings = Math.ceil(EXAMPLE_RECORDINGS / RECORDING_BLOCK) * pricing.recordingsCreditsPer100;
  return { events, recordings, total: events + recordings };
}
