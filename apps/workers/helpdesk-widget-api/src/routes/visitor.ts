/**
 * POST /api/visitor: the widget's visitor session.
 *
 * The widget calls this on load and gets back a visitor token, which every
 * other visitor route requires. Who the visitor is, in order:
 *
 *  1. `identityToken`: the customer's server vouches for a user (verified,
 *     see lib/visitor-identity). One visitor per (widget, user id).
 *  2. `visitorToken`: this browser's own anonymous visitor, kept. A token for
 *     an identified visitor without an identity token means the user signed
 *     out on the customer's site: they get a fresh anonymous visitor.
 *  3. `legacyVisitorId`: transition from the browser-made ids. An existing
 *     anonymous visitor can swap its id for a token, once.
 *  4. Otherwise a new anonymous visitor.
 *
 * With identity verification required, 2 to 4 are refused.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { attachDeskVisitorContact, type DeskVisitor } from '@weldsuite/db/lib/desk';
import { createAnonymousDeskVisitor, upsertIdentifiedDeskVisitor } from '@weldsuite/db/lib/desk-portal';
import { deskVisitorSessionRequestSchema } from '@weldsuite/app-api-client/schemas/desk-portal';
import type { Env, Variables } from '../index';
import { schema, type Database } from '../db';
import { error, success } from '../lib/response';
import { generateId } from '../lib/id';
import { publishConversationUpdated } from '../lib/desk-live';
import {
  identitySecretFingerprint,
  issueVisitorToken,
  readVisitorToken,
  requiresIdentity,
  verifyIdentityToken,
} from '../lib/visitor-identity';

export const visitorRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** KV marker: this legacy id was swapped for a token already. */
const LEGACY_EXCHANGE_TTL_SECONDS = 400 * 24 * 60 * 60;
const legacyKey = (workspaceId: string, visitorId: string) => `dvis:legacy:${workspaceId}:${visitorId}`;

async function visitorById(db: Database, id: string): Promise<DeskVisitor | null> {
  const [row] = await db.select().from(schema.deskVisitors).where(eq(schema.deskVisitors.id, id)).limit(1);
  return row ?? null;
}

async function touch(db: Database, visitor: DeskVisitor, widgetId: string): Promise<DeskVisitor> {
  const now = new Date();
  const [row] = await db
    .update(schema.deskVisitors)
    .set({ lastSeenAt: now, updatedAt: now, widgetId: visitor.widgetId ?? widgetId })
    .where(eq(schema.deskVisitors.id, visitor.id))
    .returning();
  return row ?? visitor;
}

/** The anonymous visitor this browser already holds a token for, if still valid here. */
async function keptVisitor(
  db: Database,
  secret: string,
  token: string | undefined,
  scope: { workspaceId: string; widgetId: string },
): Promise<DeskVisitor | null> {
  if (!token) return null;
  const claims = await readVisitorToken(secret, token);
  if (!claims || claims.workspaceId !== scope.workspaceId || claims.widgetId !== scope.widgetId) return null;
  const visitor = await visitorById(db, claims.visitorId);
  return visitor && !visitor.externalId ? visitor : null;
}

/** A browser-made id from before visitor tokens, swapped once for its existing visitor. */
async function exchangedLegacyVisitor(
  env: Env,
  db: Database,
  legacyId: string | undefined,
  scope: { workspaceId: string; widgetId: string },
): Promise<DeskVisitor | null> {
  if (!legacyId) return null;
  const visitor = await visitorById(db, legacyId);
  if (!visitor || visitor.externalId || visitor.verifiedEmail) return null;
  if (visitor.widgetId && visitor.widgetId !== scope.widgetId) return null;
  const key = legacyKey(scope.workspaceId, visitor.id);
  if (await env.WORKSPACE_CACHE.get(key)) return null;
  await env.WORKSPACE_CACHE.put(key, new Date().toISOString(), { expirationTtl: LEGACY_EXCHANGE_TTL_SECONDS });
  return visitor;
}

visitorRoutes.post('/', zValidator('json', deskVisitorSessionRequestSchema), async (c) => {
  const secret = c.env.WIDGET_TOKEN_SECRET;
  if (!secret) return error.internal(c, 'WIDGET_TOKEN_SECRET not configured');

  const db = c.get('tenantDb');
  const config = c.get('widgetConfig');
  const scope = { workspaceId: c.get('workspaceId'), widgetId: c.get('widgetId') };
  const data = c.req.valid('json');

  try {
    let visitor: DeskVisitor | null = null;
    // Identified sessions end with their identity token and with the secret it was signed under.
    let identified: { expiresAt: number; secretFingerprint: string } | null = null;
    if (data.identityToken) {
      if (!config.identitySecret) {
        return error.badRequest(c, 'Identity verification is not set up for this widget');
      }
      const result = await verifyIdentityToken(config.identitySecret, data.identityToken);
      if (!result.ok) return error.unauthorized(c, `Identity token refused (${result.reason})`, 'IDENTITY_INVALID');
      const { expiresAt, ...identity } = result.identity;
      visitor = await upsertIdentifiedDeskVisitor(db, generateId, { widgetId: scope.widgetId, ...identity });
      identified = { expiresAt, secretFingerprint: await identitySecretFingerprint(config.identitySecret) };
      const updated = await attachDeskVisitorContact(db, visitor.id, { name: visitor.name, email: visitor.verifiedEmail });
      const orgId = c.get('clerkOrgId');
      c.executionCtx.waitUntil(
        Promise.all(updated.map((conversation) => publishConversationUpdated(c.env, orgId, conversation))),
      );
    } else {
      if (requiresIdentity(config)) {
        return error.unauthorized(c, 'This chat is only open to signed-in users', 'IDENTITY_REQUIRED');
      }
      visitor =
        (await keptVisitor(db, secret, data.visitorToken, scope)) ??
        (await exchangedLegacyVisitor(c.env, db, data.legacyVisitorId, scope));
      visitor = visitor
        ? await touch(db, visitor, scope.widgetId)
        : await createAnonymousDeskVisitor(db, generateId, scope.widgetId);
    }

    const visitorToken = await issueVisitorToken(secret, { visitorId: visitor.id, ...scope, ...identified });
    return success(c, {
      visitorToken,
      visitor: {
        id: visitor.id,
        name: visitor.name,
        email: visitor.verifiedEmail ?? visitor.email,
        verified: Boolean(visitor.verifiedEmail),
      },
    });
  } catch (err) {
    console.error('[widget-api] visitor session failed:', err);
    return error.internal(c, 'Failed to start the visitor session');
  }
});
