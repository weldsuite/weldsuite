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
