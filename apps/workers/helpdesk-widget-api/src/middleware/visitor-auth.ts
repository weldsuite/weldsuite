/**
 * Visitor authentication for the conversation, realtime and attachment
 * routes: `Authorization: Bearer <visitor token>` (from `POST /api/visitor`)
 * → the visitor row → `visitor` and `principal` on the context.
 *
 * Runs after widgetAuthMiddleware: a token only counts for the workspace and
 * widget it was issued for. With identity verification required, a visitor
 * the customer's site never vouched for is refused here too.
 */

import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { deskPrincipalOf } from '@weldsuite/db/lib/desk-portal';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { error } from '../lib/response';
import { readVisitorToken, requiresIdentity } from '../lib/visitor-identity';

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match?.[1] ?? null;
}

export function visitorAuthMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const secret = c.env.WIDGET_TOKEN_SECRET;
    if (!secret) return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');

    const token = bearerToken(c.req.header('Authorization'));
    if (!token) return error.unauthorized(c, 'Missing visitor token', 'VISITOR_TOKEN_REQUIRED');

    const claims = await readVisitorToken(secret, token);
    if (!claims || claims.workspaceId !== c.get('workspaceId') || claims.widgetId !== c.get('widgetId')) {
      return error.unauthorized(c, 'Invalid visitor token', 'VISITOR_TOKEN_INVALID');
    }

    const db = c.get('tenantDb');
    const [visitor] = await db
      .select()
      .from(schema.deskVisitors)
      .where(eq(schema.deskVisitors.id, claims.visitorId))
      .limit(1);
    if (!visitor) return error.unauthorized(c, 'Invalid visitor token', 'VISITOR_TOKEN_INVALID');

    if (requiresIdentity(c.get('widgetConfig')) && !visitor.externalId) {
      return error.unauthorized(c, 'This chat is only open to signed-in users', 'IDENTITY_REQUIRED');
    }

    c.set('visitor', visitor);
    c.set('principal', deskPrincipalOf(visitor));
    await next();
  });
}
