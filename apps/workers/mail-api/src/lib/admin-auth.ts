/**
 * Shared staff-auth middleware for mail-api's internal admin APIs: a shared
 * secret (`OUTBOUND_ADMIN_SECRET` — design doc §8, "Admin routes reuse
 * OUTBOUND_ADMIN_SECRET") sent as `x-admin-secret`, plus the signed-in admin's
 * identity (`x-admin-email`), the same pattern the billing worker uses for its
 * own staff API. Not Clerk: the admin console calls these server-to-server.
 *
 * Extracted from `routes/internal-outbound/index.ts` (task C4,
 * docs/plans/weldmail-mailbox-store-design.md §9) so the mailbox-store admin
 * routes (`routes/internal-mail-store`) reuse it instead of a second copy.
 */

import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { Env } from '../types';

/** A short secret is a misconfiguration, not a credential. */
const MIN_SECRET_LENGTH = 32;
const adminEmailSchema = z.string().email().max(255);

export type AdminAuthVariables = { adminEmail: string };

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison: both sides are hashed to equal length first. */
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Hono middleware: 503 when `OUTBOUND_ADMIN_SECRET` isn't configured (or is
 * suspiciously short), 401 on a wrong/missing secret, 400 when the caller
 * didn't identify the acting admin. Sets `c.var.adminEmail` for route
 * handlers to log alongside whatever they did (never tenant data — see this
 * worker's admin routes' own header comments).
 */
export const adminAuth = () =>
  createMiddleware<{ Bindings: Env; Variables: AdminAuthVariables }>(async (c, next) => {
    const expected = c.env.OUTBOUND_ADMIN_SECRET;
    if (!expected || expected.length < MIN_SECRET_LENGTH) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'The admin API is not configured' } }, 503);
    }
    if (!(await secretsMatch(c.req.header('x-admin-secret') ?? '', expected))) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    }
    const email = c.req.header('x-admin-email')?.trim().toLowerCase();
    if (!email || !adminEmailSchema.safeParse(email).success) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'x-admin-email must identify the acting admin' } }, 400);
    }
    c.set('adminEmail', email);
    await next();
  });
