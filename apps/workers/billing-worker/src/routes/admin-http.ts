/**
 * Shared plumbing of the admin billing API routes (routes/admin.ts, the
 * partner routes in routes/admin-partners.ts): body parsing, the error ->
 * response mapping and the request-id format.
 *
 * Responses: `{ data }` on success, `{ error: { code, message, details? } }`
 * otherwise.
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { LicenceError, TerritoryConflictError } from '@weldsuite/core-domain/partners';
import type { Env } from '../index';
import type { AdminVariables } from '../middleware/admin-auth';
import { AdminBillingError } from '../services/admin-billing';

export type AdminEnv = { Bindings: Env; Variables: AdminVariables };
export type AdminCtx = Context<AdminEnv>;

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

export async function parseBody<T extends z.ZodTypeAny>(c: AdminCtx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AdminBillingError('BAD_REQUEST', 'The request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new AdminBillingError('BAD_REQUEST', `${where}${issue?.message ?? 'Invalid request'}`);
  }
  return parsed.data;
}

const STATUS: Record<AdminBillingError['code'], 400 | 404 | 409 | 503> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_CONFIGURED: 503,
};

/** Stripe's own message from a failed call, e.g. "Your card was declined." */
export function stripeFailure(err: unknown): { status: 400 | 502; message: string } | null {
  const text = err instanceof Error ? err.message : '';
  const match = /^Stripe API \S+ \S+ failed \((\d{3})\): ([\s\S]*)$/.exec(text);
  if (!match) return null;
  const status = Number(match[1]);
  let message = 'Stripe rejected the request';
  try {
    const body = JSON.parse(match[2]!) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  return { status: status >= 400 && status < 500 ? 400 : 502, message: `Stripe: ${message}` };
}

/** How a licence refusal reads to the admin console. */
const LICENCE_ERROR_STATUS: Record<LicenceError['code'], 400 | 404 | 409> = {
  INVALID_APPS: 400,
  PLAN_NOT_ALLOWED: 400,
  NO_CONTRACT: 409,
  NOT_FOUND: 404,
  WRONG_PARTNER: 409,
};

export function errorResponse(c: AdminCtx, err: unknown) {
  if (err instanceof AdminBillingError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      STATUS[err.code],
    );
  }
  if (err instanceof LicenceError) {
    return c.json({ error: { code: err.code, message: err.message } }, LICENCE_ERROR_STATUS[err.code]);
  }
  if (err instanceof TerritoryConflictError) {
    return c.json(
      { error: { code: 'TERRITORY_CONFLICT', message: err.message, details: { countries: err.countries } } },
      409,
    );
  }
  // STRIPE_REJECTED: Stripe refused it (4xx). STRIPE_UNAVAILABLE: Stripe
  // failed (5xx), so the write may have gone through; the console keeps its
  // idempotency key for the retry in that case.
  const stripe = stripeFailure(err);
  if (stripe) {
    const code = stripe.status === 400 ? 'STRIPE_REJECTED' : 'STRIPE_UNAVAILABLE';
    return c.json({ error: { code, message: stripe.message } }, stripe.status);
  }
  console.error('[Admin API] Unexpected error:', err);
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong. Nothing was retried.' } }, 500);
}

export function errorMessage(err: unknown): string {
  if (err instanceof AdminBillingError || err instanceof LicenceError || err instanceof TerritoryConflictError) {
    return err.message;
  }
  return stripeFailure(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

