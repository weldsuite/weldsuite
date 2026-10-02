import { z } from 'zod';

/**
 * WeldMeet AI pricing: shared (server + client) constants and validation.
 *
 * The price list lives in the master DB `system_settings` row `weldmeet.ai_pricing`
 * (category `billing`, JSON). meet-api reads it through
 * `getMeetingAiPricing` in packages/domains/meet/src/billing.ts, which owns the
 * canonical key and the stored shape; this file mirrors both. admin cannot
 * import `@weldsuite/meet-domain/billing` (it pulls in worker-kit and Workers
 * bindings), so keep the key and the rate rules below in sync with that file.
 */

/** Mirrors `WELDMEET_AI_PRICING_KEY` in packages/domains/meet/src/billing.ts. */
export const WELDMEET_AI_PRICING_KEY = 'weldmeet.ai_pricing';

/** Mirrors the upper bound enforced by `parseMeetingAiPricing` in billing.ts. */
export const MAX_CREDITS_PER_MINUTE = 1000;

/** Length of the example meeting shown on the page. */
export const EXAMPLE_MEETING_MINUTES = 60;

/** Stored value shape. Field names must match `MeetingAiPricing` in billing.ts. */
export interface WeldmeetAiPricing {
  /** Credits per meeting minute for a transcript. */
  transcriptionCreditsPerMinute: number;
  /** Credits per meeting minute for an AI summary. */
  summaryCreditsPerMinute: number;
}

export type RateErrorCode = 'invalid' | 'out_of_range' | 'decimals';

/** Same rule as `validRate` in billing.ts: > 0, <= max, at most 2 decimals. */
export function isValidRate(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value <= 0 || value > MAX_CREDITS_PER_MINUTE) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

const rateSchema = z
  .number()
  .gt(0, { message: 'invalid' })
  .max(MAX_CREDITS_PER_MINUTE, { message: 'out_of_range' })
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { message: 'decimals' });

const pricingSchema = z.object({
  transcriptionCreditsPerMinute: rateSchema,
  summaryCreditsPerMinute: rateSchema,
});

function toRateCode(message: string | undefined): RateErrorCode {
  return message === 'out_of_range' || message === 'decimals' ? message : 'invalid';
}

/** Parse form text ("1,5" and "1.5" both work); anything that is not a finite number becomes NaN. */
export function parseRateInput(raw: string): number {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return Number.NaN;
  return Number(normalized);
}

export type PricingParseResult =
  | { ok: true; data: WeldmeetAiPricing }
  | { ok: false; field: keyof WeldmeetAiPricing; code: RateErrorCode };

/** Validate the two raw form values. Reports the first failing field. */
export function parsePricingInput(input: {
  transcriptionCreditsPerMinute: string;
  summaryCreditsPerMinute: string;
}): PricingParseResult {
  const result = pricingSchema.safeParse({
    transcriptionCreditsPerMinute: parseRateInput(input.transcriptionCreditsPerMinute),
    summaryCreditsPerMinute: parseRateInput(input.summaryCreditsPerMinute),
  });
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const field =
    issue?.path[0] === 'summaryCreditsPerMinute' ? 'summaryCreditsPerMinute' : 'transcriptionCreditsPerMinute';
  return { ok: false, field, code: toRateCode(issue?.message) };
}

/**
 * Effective pricing for a stored value: every missing or invalid field falls
 * back to its default, exactly like `parseMeetingAiPricing` in billing.ts.
 */
export function resolveStoredPricing(value: unknown, defaults: WeldmeetAiPricing): WeldmeetAiPricing {
  if (!value || typeof value !== 'object') return defaults;
  const v = value as Record<string, unknown>;
  return {
    transcriptionCreditsPerMinute: isValidRate(v.transcriptionCreditsPerMinute)
      ? v.transcriptionCreditsPerMinute
      : defaults.transcriptionCreditsPerMinute,
    summaryCreditsPerMinute: isValidRate(v.summaryCreditsPerMinute)
      ? v.summaryCreditsPerMinute
      : defaults.summaryCreditsPerMinute,
  };
}

/** Same rounding as `creditsForMinutes` in billing.ts: whole credits, rounded up. */
export function creditsForMinutes(minutes: number, ratePerMinute: number): number {
  if (!(minutes > 0) || !(ratePerMinute > 0)) return 0;
  return Math.ceil(minutes * ratePerMinute - 1e-9);
}

/** Credits charged for an example meeting of `minutes`, per item and in total. */
export function exampleCharge(
  pricing: WeldmeetAiPricing,
  minutes: number = EXAMPLE_MEETING_MINUTES,
): { transcription: number; summary: number; total: number } {
  const transcription = creditsForMinutes(minutes, pricing.transcriptionCreditsPerMinute);
  const summary = creditsForMinutes(minutes, pricing.summaryCreditsPerMinute);
  return { transcription, summary, total: transcription + summary };
}
