/**
 * OAuth callback receiver — PUBLIC route, `GET /public/connectors/oauth/callback`.
 *
 * Mounted before Clerk auth: the provider redirects the tenant's browser here,
 * and that request carries no WeldSuite session. Authenticity comes entirely from
 * the HMAC-signed `state` we issued in `/api/connectors/oauth/start`, which
 * carries the workspace, connector, user and pending connection id. An invalid
 * or expired state is rejected before anything else is read — without that check
 * this endpoint would let anyone attach a connection of their choosing to any
 * workspace.
 *
 * The response is a redirect back into the platform rather than JSON, because a
 * browser is what lands here. Failures redirect with an error code in the query
 * so the UI can explain what happened; nothing sensitive goes into the URL.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDriver, hasDriver, verifyState } from '@weldsuite/connectors';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Env, Variables } from '../types';
import { getTenantDbForWorkspace } from '../db';
import { schema } from '../db';
import { completeOAuthConnect } from '../services/connectors/connections';
// Import for the registration side effect.
import '../services/connectors/drivers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Where the tenant ends up afterwards. */
function platformRedirect(env: Env, params: Record<string, string>): string {
  const base = env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
  const url = new URL('/weldconnect/connectors', base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const providerError = c.req.query('error');

  // The tenant declined the consent screen. Not an error worth logging loudly.
  if (providerError) {
    return c.redirect(platformRedirect(c.env, { connectorError: 'declined' }));
  }
  if (!code || !state) {
    return c.redirect(platformRedirect(c.env, { connectorError: 'invalid_callback' }));
  }

  const secret = c.env.CONNECTOR_STATE_SECRET;
  if (!secret) {
    console.error('[connector-oauth] CONNECTOR_STATE_SECRET is not configured');
    return c.redirect(platformRedirect(c.env, { connectorError: 'not_configured' }));
  }

  const payload = await verifyState(state, secret);
  if (!payload) {
    // Covers tampering and a state the tenant sat on for too long. Both look the
    // same from here and neither should say which.
    console.warn('[connector-oauth] rejected a callback with an invalid or expired state');
    return c.redirect(platformRedirect(c.env, { connectorError: 'invalid_state' }));
  }

  if (!hasDriver(payload.connectorId)) {
    return c.redirect(platformRedirect(c.env, { connectorError: 'unknown_connector' }));
  }

  try {
    const db = await getTenantDbForWorkspace(c.env, payload.workspaceId);

    // The state names the connection, but the row still has to exist and still
    // belong to the connector the state claims — a signed state for a deleted or
    // re-pointed connection must not resurrect it under the wrong connector.
    const [pending] = await db
      .select({ id: schema.connectorConnections.id })
      .from(schema.connectorConnections)
      .where(
        and(
          eq(schema.connectorConnections.id, payload.connectionId),
          eq(schema.connectorConnections.connectorId, payload.connectorId),
        ),
      )
      .limit(1);

    if (!pending) {
      return c.redirect(platformRedirect(c.env, { connectorError: 'connection_missing' }));
    }

    const connection = await completeOAuthConnect({
      db,
      driver: getDriver(payload.connectorId),
      connectionId: payload.connectionId,
      workspaceId: payload.workspaceId,
      code,
      // Must byte-match what was sent to the authorize endpoint or the provider
      // rejects the exchange.
      redirectUri: new URL(c.req.url).origin + new URL(c.req.url).pathname,
      env: c.env as never,
    });

    // Failures here are logged, never fatal: the connection is already active and
    // a thrown event would turn a successful authorisation into an error page.
    await publishEntityEventRaw({
      env: c.env as never,
      db: db as never,
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      entityType: 'connector_connection',
      action: 'connected',
      entityId: connection.id,
      data: {
        id: connection.id,
        connectorId: connection.connectorId,
        authMode: connection.authMode,
        externalAccountId: connection.externalAccountId,
      },
    }).catch((err: unknown) => {
      console.error('[connector-oauth] connected event failed to publish:', err);
    });

    return c.redirect(
      platformRedirect(c.env, { connectorConnected: connection.connectorId }),
    );
  } catch (err) {
    console.error('[connector-oauth] callback failed:', err);
    return c.redirect(platformRedirect(c.env, { connectorError: 'exchange_failed' }));
  }
});

export { app as connectorOAuthRoutes };
