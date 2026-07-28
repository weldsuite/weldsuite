/**
 * Nango connector routes — `/api/nango/*`, the WeldConnect admin surface.
 *
 * Browse connectors, connect one, watch its sync health, disconnect. Every
 * handler is workspace-scoped through `c.get('tenantDb')`; no route accepts a
 * workspace id from the client.
 *
 * Credentials never appear here. The only Nango material that reaches a browser
 * is a short-lived Connect session token, and it is scoped to a single
 * integration for a single end user.
 *
 * Permissions: integrations:read | integrations:create | integrations:update |
 * integrations:delete — the same keys the legacy `/api/integrations` surface
 * uses, so a role that could manage integrations can manage connectors.
 *
 * Entity events: every mutation publishes a `connector_connection` event, so
 * audit logging, workflows, analytics and agents see the connector lifecycle.
 * The events carrying the synced business data (`company`, `person`,
 * `opportunity`) are published separately by the ingest.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { NangoApiError, connectorSyncNames, getConnector, listConnectors } from '@weldsuite/nango';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  findConnectionByProvider,
  finishSyncRun,
  getNangoClient,
  listConnections,
  listSyncRuns,
  markConnectionActive,
  markConnectionDisconnected,
  markConnectionError,
  rememberConnectionWorkspace,
  sanitizeConnection,
  startSyncRun,
  upsertPendingConnection,
  type NangoConnectionRow,
} from '../../services/nango/connections';
import { schema } from '../../db';
import { and, eq, isNull } from 'drizzle-orm';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Nango is optional infrastructure — say so plainly rather than 500-ing. */
function nangoUnavailable(c: Parameters<typeof error.internal>[0]) {
  return c.json(
    {
      error: {
        code: 'NANGO_NOT_CONFIGURED',
        message: 'Connector framework is not configured for this environment',
      },
    },
    503,
  );
}

/** Translate a Nango failure into an HTTP response the UI can act on. */
function nangoErrorResponse(c: Parameters<typeof error.internal>[0], err: unknown) {
  if (err instanceof NangoApiError) {
    if (err.kind === 'auth') {
      return error.badRequest(c, 'Connector authorisation was rejected — reconnect the integration');
    }
    if (err.kind === 'rate_limit') {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Connector provider is rate limiting — try again shortly' } },
        429,
      );
    }
  }
  return error.internal(c, 'Connector request failed');
}

/** Fetch a connection row by local id, scoped to the tenant database. */
async function getConnectionRow(
  db: Variables['tenantDb'],
  id: string,
): Promise<NangoConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.nangoConnections)
    .where(and(eq(schema.nangoConnections.id, id), isNull(schema.nangoConnections.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Catalog
// ============================================================================

/**
 * Connectors we can actually import from, each with the tenant's current
 * connection state — one call powers the whole browse screen.
 */
app.get('/catalog', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const connections = await listConnections(db);
    const byProvider = new Map(connections.map((row) => [row.providerConfigKey, row]));

    const catalog = listConnectors().map((connector) => {
      const connection = byProvider.get(connector.providerConfigKey);
      return {
        providerConfigKey: connector.providerConfigKey,
        provider: connector.provider,
        label: connector.label,
        description: connector.description,
        category: connector.category,
        icon: connector.icon,
        scopes: connector.scopes,
        syncs: connector.syncs.map((s) => ({
          syncName: s.syncName,
          model: s.model,
          internalEntity: s.internalEntity,
        })),
        connection: connection ? sanitizeConnection(connection) : null,
      };
    });

    return success(c, catalog);
  } catch (err) {
    console.error('[app-api/nango] catalog failed:', err);
    return error.internal(c, 'Failed to load connector catalog');
  }
});

// ============================================================================
// Connections
// ============================================================================

app.get('/connections', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await listConnections(db);
    return success(c, rows.map(sanitizeConnection));
  } catch (err) {
    console.error('[app-api/nango] list connections failed:', err);
    return error.internal(c, 'Failed to list connections');
  }
});

const connectSessionSchema = z.object({
  providerConfigKey: z.string().min(1).max(100),
});

/**
 * Step 1 of connecting: mint a Connect session and hand back the hosted UI URL.
 *
 * `organization.id` is the Clerk org — that stamp is what lets a later sync
 * webhook be attributed to the right tenant, and what keeps one workspace's
 * connections invisible to another inside Nango.
 */
app.post(
  '/connect-session',
  requirePermission('integrations:create'),
  zValidator('json', connectSessionSchema),
  async (c) => {
    const client = getNangoClient(c.env);
    if (!client) return nangoUnavailable(c);

    const { providerConfigKey } = c.req.valid('json');
    const connector = getConnector(providerConfigKey);
    if (!connector) return error.badRequest(c, `Unknown connector '${providerConfigKey}'`);

    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const userId = c.get('userId');
    const db = c.get('tenantDb');

    try {
      const connection = await upsertPendingConnection({
        db,
        providerConfigKey,
        provider: connector.provider,
        displayName: connector.label,
        userId,
      });

      const session = await client.createConnectSession({
        end_user: { id: userId },
        organization: { id: orgId },
        allowed_integrations: [providerConfigKey],
      });

      publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'created',
        entityId: connection.id,
        data: sanitizeConnection(connection) as unknown as Record<string, unknown>,
      });

      return success(c, {
        connectionId: connection.id,
        providerConfigKey,
        sessionToken: session.token,
        expiresAt: session.expires_at,
        connectUrl: client.connectUiUrl(session.token),
      });
    } catch (err) {
      console.error('[app-api/nango] connect session failed:', err);
      return nangoErrorResponse(c, err);
    }
  },
);

const finalizeSchema = z.object({
  nangoConnectionId: z.string().min(1).max(255),
});

/**
 * Step 2: the Connect UI reports the new connection id.
 *
 * The auth webhook usually gets here first; this path exists so the UI is not
 * blocked on webhook delivery. Both are idempotent — whichever lands first
 * activates the row and the other is a no-op.
 */
app.post(
  '/connections/:id/finalize',
  requirePermission('integrations:create'),
  zValidator('json', finalizeSchema),
  async (c) => {
    const client = getNangoClient(c.env);
    if (!client) return nangoUnavailable(c);

    const db = c.get('tenantDb');
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const row = await getConnectionRow(db, c.req.param('id'));
    if (!row) return error.notFound(c, 'Connection', c.req.param('id'));

    const { nangoConnectionId } = c.req.valid('json');

    try {
      // Confirm the connection really exists in Nango and belongs to this
      // workspace before trusting a client-supplied id.
      const detail = await client.getConnection({
        connectionId: nangoConnectionId,
        providerConfigKey: row.providerConfigKey,
      });

      // FAIL CLOSED. A missing org stamp is not permission to proceed: this
      // handler goes on to point the connection→workspace KV mapping at the
      // caller's org, so accepting an unverified id would route another
      // workspace's sync webhooks into this tenant's database. Rejecting here
      // costs nothing — the auth webhook activates the connection on its own,
      // and it carries the org stamp independently.
      const ownerOrg = detail.end_user?.organization?.id;
      if (ownerOrg !== orgId) {
        return error.forbidden(c, 'Connection belongs to a different workspace');
      }

      await markConnectionActive({
        db,
        connectionId: row.id,
        nangoConnectionId,
        externalAccountId:
          (detail.connection_config?.['instance_url'] as string | undefined) ??
          (detail.connection_config?.['portalId'] as string | undefined) ??
          null,
      });
      await rememberConnectionWorkspace(c.env, row.providerConfigKey, nangoConnectionId, orgId);

      const updated = await getConnectionRow(db, row.id);
      publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'connected',
        entityId: row.id,
        data: sanitizeConnection(updated!) as unknown as Record<string, unknown>,
      });
      return success(c, sanitizeConnection(updated!));
    } catch (err) {
      console.error('[app-api/nango] finalize failed:', err);
      return nangoErrorResponse(c, err);
    }
  },
);

/** Connection detail plus live per-sync health straight from Nango. */
app.get('/connections/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionRow(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));

  const client = getNangoClient(c.env);
  let syncs: unknown[] = [];

  if (client && row.nangoConnectionId) {
    try {
      syncs = await client.getSyncStatus({
        providerConfigKey: row.providerConfigKey,
        connectionId: row.nangoConnectionId,
        syncs: connectorSyncNames(row.providerConfigKey),
      });
    } catch (err) {
      // Health is supplementary — a Nango hiccup must not hide the connection.
      console.error('[app-api/nango] sync status failed:', err);
    }
  }

  return success(c, { ...sanitizeConnection(row), syncs });
});

/** Recent sync runs — what support reads instead of opening the database. */
app.get('/connections/:id/runs', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionRow(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));

  const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100);
  const runs = await listSyncRuns(db, row.id, limit);
  return success(c, runs);
});

const syncNowSchema = z
  .object({
    /** Discard the incremental cursor and re-import everything. */
    full: z.boolean().optional(),
    syncs: z.array(z.string().min(1)).optional(),
  })
  .optional();

/** Manual "sync now". */
app.post(
  '/connections/:id/sync',
  requirePermission('integrations:update'),
  zValidator('json', syncNowSchema),
  async (c) => {
    const client = getNangoClient(c.env);
    if (!client) return nangoUnavailable(c);

    const db = c.get('tenantDb');
    const row = await getConnectionRow(db, c.req.param('id'));
    if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
    if (!row.nangoConnectionId) {
      return error.badRequest(c, 'Connection is not authorised yet');
    }

    const body = c.req.valid('json') ?? {};
    const syncs = body.syncs?.length ? body.syncs : connectorSyncNames(row.providerConfigKey);

    try {
      await client.triggerSync({
        provider_config_key: row.providerConfigKey,
        connection_id: row.nangoConnectionId,
        syncs,
        full_resync: body.full ?? false,
      });
      // Records arrive later over the sync webhook; the run rows are written
      // there. Clearing the error here keeps a stale failure from sticking.
      await db
        .update(schema.nangoConnections)
        .set({ status: 'active', lastError: null, lastErrorAt: null, updatedAt: new Date() })
        .where(eq(schema.nangoConnections.id, row.id));

      publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'sync_started',
        entityId: row.id,
        data: {
          id: row.id,
          providerConfigKey: row.providerConfigKey,
          syncs,
          full: body.full ?? false,
        },
      });

      return success(c, { triggered: syncs, full: body.full ?? false });
    } catch (err) {
      console.error('[app-api/nango] trigger sync failed:', err);
      if (err instanceof NangoApiError && err.kind === 'auth') {
        await markConnectionError({
          db,
          connectionId: row.id,
          status: 'auth_error',
          message: 'Provider rejected the stored credentials',
        });
        publishEntityEvent({
          c,
          entityType: 'connector_connection',
          action: 'auth_error',
          entityId: row.id,
          data: { id: row.id, providerConfigKey: row.providerConfigKey },
        });
      }
      return nangoErrorResponse(c, err);
    }
  },
);

/** Pause / resume every sync on a connection without disconnecting it. */
app.post('/connections/:id/pause', requirePermission('integrations:update'), async (c) => {
  const client = getNangoClient(c.env);
  if (!client) return nangoUnavailable(c);

  const db = c.get('tenantDb');
  const row = await getConnectionRow(db, c.req.param('id'));
  if (!row?.nangoConnectionId) return error.notFound(c, 'Connection', c.req.param('id'));

  try {
    await client.pauseSyncs({
      provider_config_key: row.providerConfigKey,
      connection_id: row.nangoConnectionId,
      syncs: connectorSyncNames(row.providerConfigKey),
    });
    await db
      .update(schema.nangoConnections)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(schema.nangoConnections.id, row.id));
    publishEntityEvent({
      c,
      entityType: 'connector_connection',
      action: 'paused',
      entityId: row.id,
      data: { id: row.id, providerConfigKey: row.providerConfigKey, status: 'paused' },
    });
    return success(c, { status: 'paused' });
  } catch (err) {
    console.error('[app-api/nango] pause failed:', err);
    return nangoErrorResponse(c, err);
  }
});

app.post('/connections/:id/resume', requirePermission('integrations:update'), async (c) => {
  const client = getNangoClient(c.env);
  if (!client) return nangoUnavailable(c);

  const db = c.get('tenantDb');
  const row = await getConnectionRow(db, c.req.param('id'));
  if (!row?.nangoConnectionId) return error.notFound(c, 'Connection', c.req.param('id'));

  try {
    await client.startSyncs({
      provider_config_key: row.providerConfigKey,
      connection_id: row.nangoConnectionId,
      syncs: connectorSyncNames(row.providerConfigKey),
    });
    await db
      .update(schema.nangoConnections)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(schema.nangoConnections.id, row.id));
    publishEntityEvent({
      c,
      entityType: 'connector_connection',
      action: 'resumed',
      entityId: row.id,
      data: { id: row.id, providerConfigKey: row.providerConfigKey, status: 'active' },
    });
    return success(c, { status: 'active' });
  } catch (err) {
    console.error('[app-api/nango] resume failed:', err);
    return nangoErrorResponse(c, err);
  }
});

/**
 * Disconnect: revoke inside Nango, then soft-delete locally.
 *
 * Imported rows and their `integration_entity_mappings` are deliberately kept.
 * Deleting a connector must not delete the customer's CRM data, and keeping
 * the mappings means a later reconnect updates those rows instead of importing
 * duplicates.
 */
app.delete('/connections/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionRow(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));

  const client = getNangoClient(c.env);
  if (client && row.nangoConnectionId) {
    try {
      await client.deleteConnection({
        connectionId: row.nangoConnectionId,
        providerConfigKey: row.providerConfigKey,
      });
    } catch (err) {
      // Already gone in Nango is a success for us; anything else still leaves
      // the local row disconnected so the tenant is not stuck.
      console.error('[app-api/nango] delete connection failed:', err);
    }
  }

  await markConnectionDisconnected(db, row.id);
  publishEntityEvent({
    c,
    entityType: 'connector_connection',
    action: 'disconnected',
    entityId: row.id,
    data: { id: row.id, providerConfigKey: row.providerConfigKey, provider: row.provider },
  });
  return success(c, { id: row.id, disconnected: true });
});

export { app as nangoRoutes };
