/**
 * Auth for /api/internal/admin/* — the internal admin console (apps/web/admin)
 * calling server-to-server.
 *
 * The console holds BILLING_ADMIN_SECRET and sends it as `x-admin-secret`,
 * together with the identity of the signed-in admin (`x-admin-email`,
 * `x-admin-user-id`), which it has already verified against its own Clerk
 * instance and role (viewers never get here). Every admin action records that
 * identity in `admin_audit_events`.
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../index';

export interface AdminActor {
  email: string;
  userId: string | null;
}

export type AdminVariables = { adminActor: AdminActor };

/** A short secret is a misconfiguration, not a credential. */
export const MIN_ADMIN_SECRET_LENGTH = 32;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** Constant-time comparison: both sides are hashed to equal length first. */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The admin identity from the request headers, or null when malformed. */
export function parseAdminActor(email: string | undefined, userId: string | undefined): AdminActor | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || normalized.length > 255 || !EMAIL_PATTERN.test(normalized)) return null;
  const id = userId?.trim();
  return { email: normalized, userId: id ? id.slice(0, 255) : null };
}

export const adminAuth = () =>
  createMiddleware<{ Bindings: Env; Variables: AdminVariables }>(async (c, next) => {
    const expected = c.env.BILLING_ADMIN_SECRET;
    if (!expected || expected.length < MIN_ADMIN_SECRET_LENGTH) {
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'The admin billing API is not configured' } },
        503,
      );
    }

    const provided = c.req.header('x-admin-secret') ?? '';
    if (!(await secretsMatch(provided, expected))) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    }

    const actor = parseAdminActor(c.req.header('x-admin-email'), c.req.header('x-admin-user-id'));
    if (!actor) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'x-admin-email must identify the acting admin' } },
        400,
      );
    }

    c.set('adminActor', actor);
    await next();
  });
