/**
 * Buyer session middleware for `/public/commerce-portal`.
 *
 * Auth is a hashed session token in `Authorization: Bearer` (or the
 * `cportal_session` cookie). The KV record is re-checked against
 * `commerce_portal_access.status` on every request so a staff revoke takes
 * effect immediately.
 */

import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import type { Env, Variables } from '../types';
import { schema } from '../db';
import { error } from '../lib/response';
import { kvGetJson, sessionKvKey, sha256Hex, type PortalSession } from '../lib/commerce-portal-tokens';

function readBearer(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  const header = c.req.header('Authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const cookie = c.req.header('Cookie');
  if (!cookie) return undefined;
  const match = cookie.match(/(?:^|;\s*)cportal_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function commercePortalAuthMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    if (c.get('portalPersonId') && c.get('portalPartyId')) {
      await next();
      return;
    }

    const raw = readBearer(c);
    if (!raw) return error.unauthorized(c, 'Sign in required');

    const tokenHash = await sha256Hex(raw);
    const session = await kvGetJson<PortalSession>(c.env, sessionKvKey(tokenHash));
    if (!session) return error.unauthorized(c, 'Session expired');

    if (c.get('workspaceId') && session.workspaceId !== c.get('workspaceId')) {
      return error.unauthorized(c, 'Session expired');
    }

    const db = c.get('tenantDb');
    const [access] = await db
      .select()
      .from(schema.commercePortalAccess)
      .where(
        and(
          eq(schema.commercePortalAccess.id, session.accessId),
          eq(schema.commercePortalAccess.status, 'active'),
        ),
      )
      .limit(1);

    if (!access) return error.unauthorized(c, 'Access revoked');

    c.set('portalPersonId', session.personId);
    c.set('portalCompanyId', session.companyId);
    c.set('portalPartyId', session.partyId);
    c.set('portalAccessId', session.accessId);
    c.set('portalEmail', session.email);
    c.set('portalSessionToken', raw);
    await next();
  });
}
