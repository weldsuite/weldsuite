/**
 * The visitor behind an optional visitor token, for routes anyone may call
 * but that show more to a known reader (article search, announcements).
 *
 * The same checks as visitorAuthMiddleware: a token for this workspace and
 * widget, a visitor row, and for an identified visitor the widget's current
 * identity secret. Any failure, or no token, reads as anonymous (null)
 * instead of a 401: these routes never refuse a reader.
 */

import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { deskPrincipalOf, type DeskPrincipal } from '@weldsuite/db/lib/desk-portal';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { bearerToken } from '../middleware/visitor-auth';
import { identitySecretFingerprint, readVisitorToken } from './visitor-identity';

export async function optionalVisitorPrincipal(
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<DeskPrincipal | null> {
  const secret = c.env.WIDGET_TOKEN_SECRET;
  const token = bearerToken(c.req.header('Authorization'));
  if (!secret || !token) return null;

  const claims = await readVisitorToken(secret, token);
  if (!claims || claims.workspaceId !== c.get('workspaceId') || claims.widgetId !== c.get('widgetId')) return null;

  const [visitor] = await c
    .get('tenantDb')
    .select()
    .from(schema.deskVisitors)
    .where(eq(schema.deskVisitors.id, claims.visitorId))
    .limit(1);
  if (!visitor) return null;

  if (visitor.externalId) {
    const config = c.get('widgetConfig');
    const current = config.identitySecret ? await identitySecretFingerprint(config.identitySecret) : null;
    if (!current || claims.secretFingerprint !== current) return null;
  }
  return deskPrincipalOf(visitor);
}
