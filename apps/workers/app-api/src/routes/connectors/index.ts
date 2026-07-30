/**
 * Connector routes — `/api/connectors/*`, the WeldConnect admin surface.
 *
 * Browse connectors, connect one, watch its sync health, disconnect. Every
 * handler is workspace-scoped through `c.get('tenantDb')`; no route accepts a
 * workspace id from the client.
 *
 * Credentials never leave this layer. Responses are built from
 * `PUBLIC_CONNECTION_COLUMNS`, an explicit projection that omits `oauth_tokens`
 * and `webhook_secret` — a `select()` would start leaking any credential column
 * added later.
 *
 * Permissions: integrations:read | :create | :update | :delete — the same keys
 * the `/api/integrations` surface uses, so a role that could manage integrations
 * can manage connectors.
 *
 * Entity events: every mutation publishes a `connector_connection` event so audit
 * logging, workflows, analytics and agents see the connector lifecycle. The
 * events carrying synced business data are published separately by the ingest.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  ConnectorApiError,
  findDriver,
  getConnector,
  isSyncEntityType,
  listConnectors,
  syncSetSyncIndexEnabled,
  type SyncIndexSync,
} from '@weldsuite/connectors';
import type { ConnectorConnection } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import {
  connectWithApiToken,
  disconnectConnection,
  startOAuthConnect,
  PUBLIC_CONNECTION_COLUMNS,
} from '../../services/connectors/connections';
import { runConnectionSync, runEntitySync } from '../../services/connectors/sync';
// Import for the registration side effect — every handler below resolves drivers.
import '../../services/connectors/drivers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Translate a connector failure into a response the UI can act on. */
function connectorErrorResponse(c: Parameters<typeof error.internal>[0], err: unknown) {
  if (err instanceof ConnectorApiError) {
    if (err.kind === 'auth') {
      return error.badRequest(c, 'Connector authorisation was rejected — reconnect the integration');
    }
    if (err.kind === 'rate_limit') {
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Connector provider is rate limiting — try again shortly',
          },
        },
        429,
      );
    }
    if (err.status === 404) return error.notFound(c, err.message);
    if (err.status === 503) {
      return c.json({ error: { code: 'CONNECTOR_NOT_CONFIGURED', message: err.message } }, 503);
    }
    if (err.kind === 'permanent') return error.badRequest(c, err.message);
  }
  return error.internal(c, 'Connector request failed');
}

/** Live connections for the tenant, without credential columns. */
function listConnections(db: Variables['tenantDb']) {
  return db
    .select(PUBLIC_CONNECTION_COLUMNS)
    .from(schema.connectorConnections)
    .where(isNull(schema.connectorConnections.deletedAt));
}

/** Full row by local id — internal use only; carries credentials. */
async function getConnectionRow(
  db: Variables['tenantDb'],
  id: string,
): Promise<ConnectorConnection | null> {
  const [row] = await db
    .select()
    .from(schema.connectorConnections)
    .where(
      and(eq(schema.connectorConnections.id, id), isNull(schema.connectorConnections.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Catalog
// ============================================================================

/**
 * Connectors we can actually import from, each with the tenant's current
 * connection state — one call powers the whole browse screen.
 *
 * `authModes` comes off the driver rather than the catalog entry, so what the UI
 * offers is exactly what the code can do. A catalog entry with no registered
 * driver is omitted entirely; showing it would promise a connect flow that 500s.
 */
app.get('/catalog', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const connections = await listConnections(db);
    const byConnector = new Map(connections.map((row) => [row.connectorId, row]));

    const catalog = listConnectors().flatMap((connector) => {
      const driver = findDriver(connector.id);
      if (!driver) {
        console.warn(`[app-api/connectors] catalog entry ${connector.id} has no registered driver`);
        return [];
      }
      return [
        {
          id: connector.id,
          label: connector.label,
          description: connector.description,
          category: connector.category,
          icon: connector.icon,
          scopes: connector.scopes,
          authModes: driver.authModes,
          entities: connector.entities.map((e) => e.entity),
          supportsWebhooks: typeof driver.verifyWebhookSignature === 'function',
          connection: byConnector.get(connector.id) ?? null,
        },
      ];
    });

    return success(c, catalog);
  } catch (err) {
    console.error('[app-api/connectors] catalog failed:', err);
    return error.internal(c, 'Failed to load connector catalog');
  }
});

// ============================================================================
// Connections
// ============================================================================

app.get('/connections', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await listConnections(db));
  } catch (err) {
    console.error('[app-api/connectors] list connections failed:', err);
    return error.internal(c, 'Failed to list connections');
  }
});

app.get('/connections/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const [row] = await db
      .select(PUBLIC_CONNECTION_COLUMNS)
      .from(schema.connectorConnections)
      .where(
        and(
          eq(schema.connectorConnections.id, c.req.param('id')),
          isNull(schema.connectorConnections.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return error.notFound(c, 'Connection not found');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/connectors] get connection failed:', err);
    return error.internal(c, 'Failed to load connection');
  }
});

app.get('/connections/:id/runs', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const runs = await db
      .select()
      .from(schema.connectorSyncRuns)
      .where(eq(schema.connectorSyncRuns.connectionId, c.req.param('id')))
      .orderBy(desc(schema.connectorSyncRuns.createdAt))
      .limit(50);
    return success(c, runs);
  } catch (err) {
    console.error('[app-api/connectors] list runs failed:', err);
    return error.internal(c, 'Failed to load sync runs');
  }
});

// ============================================================================
// Connecting
// ============================================================================

const oauthStartSchema = z.object({
  connectorId: z.string().min(1).max(100),
  /**
   * Where the provider sends the browser back to. Validated against the
   * configured callback origin rather than trusted, because an open redirect here
   * would hand an attacker the authorization code.
   */
  redirectUri: z.string().url().max(2000),
});

/**
 * Step 1 of an OAuth connect: create the pending connection and hand back the
 * provider's authorize URL.
 *
 * The signed `state` carries workspace, connector, user and connection id, which
 * is what lets the public callback authenticate itself with no session.
 */
app.post(
  '/oauth/start',
  requirePermission('integrations:create'),
  zValidator('json', oauthStartSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const { connectorId, redirectUri } = c.req.valid('json');

    const allowedOrigin = c.env.CONNECTOR_OAUTH_REDIRECT_ORIGIN;
    if (allowedOrigin && !redirectUri.startsWith(allowedOrigin)) {
      return error.badRequest(c, 'redirectUri is not an allowed callback URL');
    }

    try {
      const { connection, authorizeUrl } = await startOAuthConnect({
        db,
        connectorId,
        workspaceId,
        userId,
        redirectUri,
        env: c.env as never,
      });

      await publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'created',
        entityId: connection.id,
        data: { id: connection.id, connectorId, authMode: 'oauth2', status: connection.status },
      });

      return success(c, { connectionId: connection.id, authorizeUrl });
    } catch (err) {
      console.error('[app-api/connectors] oauth start failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

const apiTokenSchema = z.object({
  connectorId: z.string().min(1).max(100),
  apiToken: z.string().min(1).max(4000),
  settings: z.record(z.unknown()).optional(),
});

/**
 * Connect with a tenant-supplied API token.
 *
 * The token is proven by calling the provider before the connection is
 * activated, so a wrong paste fails here rather than as an empty sync hours
 * later.
 */
app.post(
  '/api-token',
  requirePermission('integrations:create'),
  zValidator('json', apiTokenSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { connectorId, apiToken, settings } = c.req.valid('json');

    const driver = findDriver(connectorId);
    if (!driver) return error.notFound(c, `Unknown connector: ${connectorId}`);

    try {
      const connection = await connectWithApiToken({
        db,
        driver,
        workspaceId: c.get('workspaceId'),
        userId: c.get('userId'),
        apiToken,
        settings: settings ?? null,
        env: c.env as never,
      });

      await publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'connected',
        entityId: connection.id,
        data: {
          id: connection.id,
          connectorId,
          authMode: 'api_token',
          externalAccountId: connection.externalAccountId,
        },
      });

      // Re-read through the public projection so no credential can escape.
      const [safe] = await db
        .select(PUBLIC_CONNECTION_COLUMNS)
        .from(schema.connectorConnections)
        .where(eq(schema.connectorConnections.id, connection.id))
        .limit(1);

      return success(c, safe, 201);
    } catch (err) {
      console.error('[app-api/connectors] api token connect failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

// ============================================================================
// Sync control
// ============================================================================

const syncSchema = z
  .object({
    /** Omit to sync every enabled entity. */
    entityType: z.string().max(50).optional(),
    fullResync: z.boolean().optional(),
  })
  .optional();

app.post(
  '/connections/:id/sync',
  requirePermission('integrations:update'),
  zValidator('json', syncSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json') ?? {};

    const connection = await getConnectionRow(db, c.req.param('id'));
    if (!connection) return error.notFound(c, 'Connection not found');
    if (connection.status === 'pending') {
      return error.badRequest(c, 'Connection has not finished authorising yet');
    }

    const driver = findDriver(connection.connectorId);
    if (!driver) return error.badRequest(c, `No driver registered for ${connection.connectorId}`);

    const shared = {
      db,
      connection,
      driver,
      trigger: 'manual' as const,
      ownerId: c.get('userId'),
      workspaceId: c.get('workspaceId'),
      env: c.env as never,
      fullResync: body.fullResync ?? false,
    };

    try {
      if (body.entityType) {
        if (!isSyncEntityType(body.entityType)) {
          return error.badRequest(c, `Unknown entity type: ${body.entityType}`);
        }
        return success(c, [await runEntitySync({ ...shared, entityType: body.entityType })]);
      }
      return success(c, await runConnectionSync(shared));
    } catch (err) {
      console.error('[app-api/connectors] manual sync failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

/** Pause and resume are the same write with a different target status. */
async function setPausedState(
  c: Parameters<typeof error.internal>[0],
  db: Variables['tenantDb'],
  indexSync: SyncIndexSync,
  connectionId: string,
  paused: boolean,
) {
  const connection = await getConnectionRow(db, connectionId);
  if (!connection) return error.notFound(c, 'Connection not found');

  // Do not paper over a broken connection: resuming an `auth_error` connection
  // as `active` would hide that the tenant still has to reauthorise.
  if (!paused && connection.status === 'auth_error') {
    return error.badRequest(c, 'Reconnect the integration before resuming syncs');
  }

  await db
    .update(schema.connectorConnections)
    .set({ status: paused ? 'paused' : 'active', updatedAt: new Date() })
    .where(eq(schema.connectorConnections.id, connection.id));

  // Disabled rather than removed, so resuming keeps the tenant's interval and
  // `last_run_at` instead of re-importing from scratch. The queue consumer also
  // re-checks status on delivery, so a message already in flight is discarded.
  await syncSetSyncIndexEnabled(indexSync, connection.id, !paused);

  return success(c, { id: connection.id, status: paused ? 'paused' : 'active' });
}

app.post('/connections/:id/pause', requirePermission('integrations:update'), async (c) =>
  setPausedState(
    c,
    c.get('tenantDb'),
    { d1: c.env.SYNC_INDEX as SyncIndexSync['d1'], workspaceId: c.get('workspaceId') },
    c.req.param('id'),
    true,
  ),
);

app.post('/connections/:id/resume', requirePermission('integrations:update'), async (c) =>
  setPausedState(
    c,
    c.get('tenantDb'),
    { d1: c.env.SYNC_INDEX as SyncIndexSync['d1'], workspaceId: c.get('workspaceId') },
    c.req.param('id'),
    false,
  ),
);

// ============================================================================
// Disconnect
// ============================================================================

/**
 * Disconnect a connector.
 *
 * Imported rows and their mappings are both kept — removing a connector must
 * never delete the customer's data, and the surviving mappings mean reconnecting
 * re-links instead of importing everything again as duplicates.
 */
app.delete('/connections/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const connection = await getConnectionRow(db, c.req.param('id'));
  if (!connection) return error.notFound(c, 'Connection not found');

  const driver = findDriver(connection.connectorId);
  if (!driver) return error.badRequest(c, `No driver registered for ${connection.connectorId}`);

  try {
    await disconnectConnection({ db, driver, connection, env: c.env as never });

    await publishEntityEvent({
      c,
      entityType: 'connector_connection',
      action: 'disconnected',
      entityId: connection.id,
      data: { id: connection.id, connectorId: connection.connectorId },
    });

    return c.body(null, 204);
  } catch (err) {
    console.error('[app-api/connectors] disconnect failed:', err);
    return connectorErrorResponse(c, err);
  }
});

export { app as connectorRoutes };
