/**
 * Auth for /api/internal/admin/*: the internal admin console (apps/web/admin)
 * calling server-to-server.
 *
 * The console holds WORKSPACE_ADMIN_SECRET and sends it as `x-admin-secret`,
 * together with the identity of the signed-in admin (`x-admin-email`,
 * `x-admin-user-id`) and the role it resolved from its own Clerk instance
 * (`x-admin-role`). The secret proves the caller is the console; the identity
 * is what the audit trail records. Every route that changes something (any
 * method other than GET, HEAD and OPTIONS) needs a `superadmin`; reads are open
 * to every role, so a route added later is safe by default.
 */

import { createMiddleware } from 'hono/factory';
import { ADMIN_ROLES, type AdminRole } from '@weldsuite/db/schema/master';
import type { Env } from '../index';

export interface AdminActor {
  email: string;
  userId: string | null;
  role: AdminRole;
}

export type AdminVariables = { adminActor: AdminActor };

/** A short secret is a misconfiguration, not a credential. */
export const MIN_ADMIN_SECRET_LENGTH = 32;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/** The admin identity from the request headers, or null when it is incomplete or malformed. */
export function parseAdminActor(
  email: string | undefined,
  userId: string | undefined,
  role: string | undefined,
): AdminActor | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || normalized.length > 255 || !EMAIL_PATTERN.test(normalized)) return null;
  const normalizedRole = role?.trim().toLowerCase();
  const matched = ADMIN_ROLES.find((candidate) => candidate === normalizedRole);
  if (!matched) return null;
  const id = userId?.trim();
  return { email: normalized, userId: id ? id.slice(0, 255) : null, role: matched };
}

function error(code: string, message: string) {
  return { error: { code, message } };
}

export const adminAuth = () =>
  createMiddleware<{ Bindings: Env; Variables: AdminVariables }>(async (c, next) => {
    const expected = c.env.WORKSPACE_ADMIN_SECRET;
    if (!expected || expected.length < MIN_ADMIN_SECRET_LENGTH) {
      return c.json(error('NOT_CONFIGURED', 'The admin workspace API is not configured'), 503);
    }

    const provided = c.req.header('x-admin-secret') ?? '';
    if (!(await secretsMatch(provided, expected))) {
      return c.json(error('UNAUTHORIZED', 'Unauthorized'), 401);
    }

    const actor = parseAdminActor(
      c.req.header('x-admin-email'),
      c.req.header('x-admin-user-id'),
      c.req.header('x-admin-role'),
    );
    if (!actor) {
      return c.json(error('UNAUTHORIZED', 'x-admin-email and x-admin-role must identify the acting admin'), 401);
    }

    if (!READ_ONLY_METHODS.has(c.req.method) && actor.role !== 'superadmin') {
      return c.json(error('FORBIDDEN', 'Only a superadmin can change database placement'), 403);
    }

    c.set('adminActor', actor);
    await next();
  });
