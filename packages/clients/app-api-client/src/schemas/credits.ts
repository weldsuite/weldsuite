/**
 * Credit topup checkout — shared Zod v3 contract for
 * `POST /api/credits/checkout` (app-api → billing-worker proxy).
 *
 * `successUrl` / `cancelUrl` must be https (or http localhost) origins that
 * match the platform SPA origins allowed by app-api CORS. Rejecting other
 * origins prevents open-redirect / phishing via Stripe Checkout callbacks.
 */

import { z } from 'zod';

/**
 * Keep in sync with the CORS `allowed` list in
 * `apps/workers/app-api/src/index.ts` (platform SPA origins only).
 */
export const PLATFORM_CHECKOUT_ORIGINS = [
  'https://app.weldsuite.org',
  'https://app-test.weldsuite.org',
  'https://app-preview.weldsuite.org',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
] as const;

/** True when `urlString` is a valid absolute URL on an allowed platform origin. */
export function isAllowedPlatformCheckoutUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol === 'http:') {
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false;
    } else if (url.protocol !== 'https:') {
      return false;
    }
    return (PLATFORM_CHECKOUT_ORIGINS as readonly string[]).includes(url.origin);
  } catch {
    return false;
  }
}

const platformCheckoutUrlSchema = z
  .string()
  .url()
  .refine(isAllowedPlatformCheckoutUrl, {
    message:
      'URL must use an allowed platform origin (app.weldsuite.org or local Vite ports)',
  });

export const creditTopupCheckoutSchema = z.object({
  packageId: z.string().min(1),
  successUrl: platformCheckoutUrlSchema.optional(),
  cancelUrl: platformCheckoutUrlSchema.optional(),
});

export type CreditTopupCheckoutInput = z.infer<typeof creditTopupCheckoutSchema>;

// ============================================================================
// Answers of the wallet reads (`{ success, data }`, api-worker's envelope)
// ============================================================================

/** `GET /api/credits/balance`. */
export const creditBalanceSchema = z.object({
  currentBalance: z.number(),
  planCredits: z.number(),
  subscribedCredits: z.number(),
  monthlyAllocation: z.number(),
  rolledOverCredits: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
  daysRemaining: z.number(),
  usagePercentage: z.number(),
  isLow: z.boolean(),
  isExhausted: z.boolean(),
});

export type CreditBalance = z.infer<typeof creditBalanceSchema>;

/** A row of `GET /api/credits/transactions` (paged by `page`/`pageSize`). */
export const creditTransactionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  amount: z.number(),
  balanceAfter: z.number(),
  serviceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  referenceType: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  stripePaymentIntentId: z.string().nullable(),
  stripeCheckoutSessionId: z.string().nullable(),
  /** `numeric(10,2)`, as Postgres writes it (`"12.50"`). */
  amountPaid: z.string().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  userId: z.string().nullable(),
  createdAt: z.string(),
});

export type CreditTransaction = z.infer<typeof creditTransactionSchema>;

/** `POST /api/credits/check`. */
export const creditAvailabilitySchema = z.object({
  available: z.boolean(),
  currentBalance: z.number(),
  required: z.number(),
  shortfall: z.number(),
  message: z.string().optional(),
});

/** A package of `GET /api/credits/packages`. */
export const creditPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  credits: z.number(),
  price: z.number(),
  currency: z.string(),
  stripePriceId: z.string().nullable(),
  isPopular: z.boolean(),
});

/** `GET /api/credits/rates`: the defaults, overridden by the plan's `creditRates`. */
export const creditRatesSchema = z
  .object({
    aiTokens: z.number(),
    parcelLabel: z.number(),
    meetingBotMinute: z.number(),
    callTranscriptionMinute: z.number(),
    voipCallMinute: z.number(),
    transcriptionProvider: z.enum(['assemblyai', 'openai']),
    hunterEmailFinder: z.number(),
    hunterEmailVerifier: z.number(),
    hunterDomainSearch: z.number(),
  })
  .passthrough();

/** `GET /api/credits/usage`: this period's consumption by service. */
export const creditUsageSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  totalAllocated: z.number(),
  totalConsumed: z.number(),
  totalRemaining: z.number(),
  byService: z.record(z.object({ credits: z.number(), count: z.number() })),
});

/** `GET /api/credits/subscription`. */
export const subscriptionCreditsSchema = z.object({
  planCredits: z.number(),
  subscribedCredits: z.number(),
  totalMonthly: z.number(),
  stripeItemId: z.string().nullable().optional(),
  stripePriceId: z.string().nullable().optional(),
});

/** `POST /api/credits/checkout`: the hosted Stripe Checkout page. */
export const creditCheckoutSessionSchema = z.object({ url: z.string() });
