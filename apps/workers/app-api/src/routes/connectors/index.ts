/**
 * First-party connector routes — `/api/connectors/*`, the WeldConnect admin surface.
 *
 * Browse connectors, connect one with provider credentials, choose which
 * objects to sync on the connection itself, watch sync health, disconnect.
 *
 * Permissions: integrations:read | integrations:create | integrations:update |
 * integrations:delete — the same keys the legacy `/api/integrations` surface
 * uses, so a role that could manage integrations can manage connectors.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  ConnectorApiError,
  DEFAULT_ENABLED_SYNCS,
  generateWebhookSecret,
  getConnector,
  listConnectors,
} from '@weldsuite/connectors';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getWorkspaceForOrg, schema } from '../../db';
import {
  decryptCredentials,
  encryptCredentials,
  encryptWebhookSecret,
  getConnectionById,
  keyringFromEnv,
  listConnectionRecords,
  listConnections,
  listSyncRuns,
  markConnectionDisconnected,
  sanitizeConnection,
  sanitizeConnectionWithEntity,
  updateConnectionSettings,
  upsertConnection,
} from '../../services/connectors/connections';
import { testConnectorCredentials } from '../../services/connectors/clients';
import { syncConnection } from '../../services/connectors/sync';
import { startWooCommerceAppAuth, startMoneybirdOAuth, completeMoneybirdOAuth, selectMoneybirdAdministration } from '../../services/connectors/auth';
import {
  deleteConnectorWebhookMapping,
  putConnectorWebhookMapping,
  registerConnectionWebhooks,
  unregisterConnectionWebhooks,
} from '../../services/connectors/webhooks';
import { and, eq, isNull } from 'drizzle-orm';
import {
  removeConnectorIndex,
  setConnectorIndexEnabled,
  upsertConnectorIndexFromRow,
} from '../../lib/connector-sync-index';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function connectorErrorResponse(c: Parameters<typeof error.internal>[0], err: unknown) {
  if (err instanceof ConnectorApiError) {
    if (err.kind === 'auth') {
      return error.badRequest(c, 'Connector authorisation was rejected — check the stored credentials');
    }
    if (err.kind === 'rate_limit') {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Connector provider is rate limiting — try again shortly' } },
        429,
      );
    }
    if (err.kind === 'permanent') {
      return error.badRequest(c, err.message);
    }
  }
  return error.internal(c, 'Connector request failed');
}

function normalizeEnabledSyncs(provider: string, enabled: string[] | undefined): string[] {
  const connector = getConnector(provider);
  if (!connector) return enabled?.length ? enabled : [...DEFAULT_ENABLED_SYNCS];
  const allowed = new Set([
    ...connector.syncs.map((s) => s.syncName),
    ...connector.syncs.map((s) => s.settingKey),
  ]);
  const requested = enabled?.length ? enabled : connector.syncs.map((s) => s.settingKey);
  return requested.filter((value) => allowed.has(value));
}

async function testProviderCredentials(
  provider: string,
  credentials: Record<string, string>,
): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
  return testConnectorCredentials(provider, credentials);
}

app.get('/catalog', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const connections = await listConnections(db);
    const keyring = keyringFromEnv(c.env);
    const catalog = await Promise.all(
      listConnectors().map(async (connector) => {
        const rows = connections.filter((row) => row.provider === connector.provider);
        const sanitized = await Promise.all(
          rows.map((row) =>
            connector.category === 'accounting'
              ? sanitizeConnectionWithEntity(row, keyring)
              : Promise.resolve(sanitizeConnection(row)),
          ),
        );
        return {
          provider: connector.provider,
          label: connector.label,
          description: connector.description,
          category: connector.category,
          icon: connector.icon,
          auth: connector.auth,
          syncs: connector.syncs.map((s) => ({
            syncName: s.syncName,
            model: s.model,
            internalEntity: s.internalEntity,
            settingKey: s.settingKey,
          })),
          connections: sanitized,
          connectionCount: sanitized.length,
        };
      }),
    );

    return success(c, catalog);
  } catch (err) {
    console.error('[app-api/connectors] catalog failed:', err);
    return error.internal(c, 'Failed to load connector catalog');
  }
});

app.get('/connections', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await listConnections(db);
    return success(c, rows.map(sanitizeConnection));
  } catch (err) {
    console.error('[app-api/connectors] list connections failed:', err);
    return error.internal(c, 'Failed to list connections');
  }
});

const connectSchema = z.object({
  provider: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255).optional(),
  credentials: z.record(z.string().min(1)),
  enabledSyncs: z.array(z.string().min(1)).optional(),
});

app.post('/connect', requirePermission('integrations:create'), zValidator('json', connectSchema), async (c) => {
  const { provider, displayName, credentials, enabledSyncs } = c.req.valid('json');
  const connector = getConnector(provider);
  if (!connector) return error.badRequest(c, `Unknown connector '${provider}'`);

  if (connector.auth.kind === 'oauth2') {
    return error.badRequest(
      c,
      'Connect this administration from the Connect button — Moneybird authorises via OAuth',
    );
  }

  if (connector.auth.kind === 'app_auth' && (!credentials.consumerKey || !credentials.consumerSecret)) {
    return error.badRequest(
      c,
      'Connect this store from the Connect button — WooCommerce creates the API keys after you approve access',
    );
  }

  for (const field of connector.auth.fields) {
    if ((field.required ?? true) && !credentials[field.key]?.trim()) {
      return error.badRequest(c, `${field.label} is required`);
    }
  }

  try {
    const tested = await testProviderCredentials(provider, credentials);
    if (!tested.ok) return error.badRequest(c, tested.message);

    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const clerkOrgId = c.get('workspaceId');
    const keyring = keyringFromEnv(c.env);
    const encrypted = await encryptCredentials(credentials, keyring);
    const syncs = normalizeEnabledSyncs(provider, enabledSyncs);
    let hostname = tested.storeUrl;
    try {
      hostname = new URL(tested.storeUrl).host;
    } catch {
      /* keep storeUrl */
    }
    const label = displayName?.trim() || `${connector.label} (${hostname})`;
    const rawWebhookSecret = provider === 'shopify' ? credentials.apiSecret : generateWebhookSecret();
    const encryptedWebhookSecret = rawWebhookSecret
      ? await encryptWebhookSecret(rawWebhookSecret, keyring)
      : null;

    const row = await upsertConnection({
      db,
      provider,
      displayName: label,
      userId,
      credentials: encrypted,
      enabledSyncs: syncs,
      externalAccountId: tested.storeUrl,
      webhookSecret: encryptedWebhookSecret,
    });

    let warning: string | null = null;
    try {
      const registered = await registerConnectionWebhooks({
        db,
        env: c.env,
        connection: { ...row, enabledSyncs: syncs },
        credentials,
        webhookSecret: rawWebhookSecret,
      });
      warning = registered.warning;
    } catch (err) {
      console.error('[app-api/connectors] webhook registration failed:', err);
      warning = 'Connected. Webhook registration failed — use Sync now until the store can push updates.';
    }

    if (clerkOrgId) {
      try {
        const { id: internalWorkspaceId } = await getWorkspaceForOrg(c.env, clerkOrgId);
        await putConnectorWebhookMapping({
          env: c.env,
          connectionId: row.id,
          workspaceId: internalWorkspaceId,
          provider,
        });
        await upsertConnectorIndexFromRow(c.env, {
          connection: row,
          workspaceId: internalWorkspaceId,
          clerkOrgId,
          enabled: true,
        });
      } catch (err) {
        console.error('[app-api/connectors] webhook KV mapping failed:', err);
      }
    }

    const fresh = await getConnectionById(db, row.id);
    publishEntityEvent({
      c,
      entityType: 'connector_connection',
      action: 'connected',
      entityId: row.id,
      data: sanitizeConnection(fresh ?? row) as unknown as Record<string, unknown>,
    });

    if (clerkOrgId) {
      c.executionCtx.waitUntil(
        syncConnection({
          db,
          env: c.env,
          connection: fresh ?? row,
          ownerId: userId,
          workspaceId: clerkOrgId,
          trigger: 'initial',
        }).catch((err) => {
          console.error('[app-api/connectors] initial sync failed:', err);
        }),
      );
    }

    return success(c, { ...sanitizeConnection(fresh ?? row), warning }, 201);
  } catch (err) {
    console.error('[app-api/connectors] connect failed:', err);
    return connectorErrorResponse(c, err);
  }
});

const authorizeSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('woocommerce'),
    storeUrl: z.string().min(1).max(500),
    displayName: z.string().min(1).max(255).optional(),
    enabledSyncs: z.array(z.string().min(1)).optional(),
    returnUrl: z.string().url(),
  }),
  z.object({
    provider: z.literal('moneybird'),
    displayName: z.string().min(1).max(255).optional(),
    enabledSyncs: z.array(z.string().min(1)).optional(),
    returnUrl: z.string().url(),
    entityId: z.string().min(1).max(30).optional(),
  }),
]);

app.post('/authorize', requirePermission('integrations:create'), zValidator('json', authorizeSchema), async (c) => {
  const body = c.req.valid('json');
  const clerkOrgId = c.get('workspaceId');
  if (!clerkOrgId) return error.orgRequired(c);

  try {
    if (body.provider === 'moneybird') {
      if (body.entityId) {
        const [entity] = await c
          .get('tenantDb')
          .select({ id: schema.entities.id })
          .from(schema.entities)
          .where(and(eq(schema.entities.id, body.entityId), isNull(schema.entities.deletedAt)))
          .limit(1);
        if (!entity) return error.badRequest(c, 'Accounting entity not found');
      }
      const result = await startMoneybirdOAuth({
        env: c.env,
        clerkOrgId,
        userId: c.get('userId'),
        enabledSyncs: normalizeEnabledSyncs(body.provider, body.enabledSyncs),
        displayName: body.displayName,
        returnUrl: body.returnUrl,
        entityId: body.entityId ?? null,
      });
      if ('error' in result) return error.badRequest(c, result.error);
      return success(c, result);
    }

    const result = await startWooCommerceAppAuth({
      db: c.get('tenantDb'),
      env: c.env,
      clerkOrgId,
      userId: c.get('userId'),
      storeUrl: body.storeUrl,
      enabledSyncs: normalizeEnabledSyncs(body.provider, body.enabledSyncs),
      displayName: body.displayName,
      returnUrl: body.returnUrl,
      requestOrigin: new URL(c.req.url).origin,
    });
    if ('error' in result) return error.badRequest(c, result.error);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/connectors] authorize failed:', err);
    return connectorErrorResponse(c, err);
  }
});

const oauthCallbackSchema = z.object({
  provider: z.literal('moneybird'),
  code: z.string().min(1),
  state: z.string().min(1),
});

app.post('/oauth/callback', requirePermission('integrations:create'), zValidator('json', oauthCallbackSchema), async (c) => {
  const body = c.req.valid('json');
  try {
    const result = await completeMoneybirdOAuth({
      env: c.env,
      code: body.code,
      state: body.state,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
    if ('error' in result) {
      return c.json({ error: { code: 'BAD_REQUEST', message: result.error } }, result.status as 400);
    }
    return success(c, result);
  } catch (err) {
    console.error('[app-api/connectors] oauth callback failed:', err);
    return connectorErrorResponse(c, err);
  }
});

const selectAccountSchema = z.object({
  administrationId: z.string().min(1).max(100),
});

app.post(
  '/connections/:id/select-account',
  requirePermission('integrations:create'),
  zValidator('json', selectAccountSchema),
  async (c) => {
    const clerkOrgId = c.get('workspaceId');
    if (!clerkOrgId) return error.orgRequired(c);
    try {
      const result = await selectMoneybirdAdministration({
        db: c.get('tenantDb'),
        env: c.env,
        connectionId: c.req.param('id'),
        administrationId: c.req.valid('json').administrationId,
        clerkOrgId,
        userId: c.get('userId'),
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      });
      if ('error' in result) {
        if (result.status === 404) return error.notFound(c, 'Connection', c.req.param('id'));
        return error.badRequest(c, result.error);
      }
      return success(c, result);
    } catch (err) {
      console.error('[app-api/connectors] select-account failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

const testSchema = z.object({
  provider: z.string().min(1).max(100),
  credentials: z.record(z.string().min(1)),
});

app.post('/test', requirePermission('integrations:create'), zValidator('json', testSchema), async (c) => {
  const { provider, credentials } = c.req.valid('json');
  if (!getConnector(provider)) return error.badRequest(c, `Unknown connector '${provider}'`);
  try {
    const tested = await testProviderCredentials(provider, credentials);
    if (!tested.ok) return error.badRequest(c, tested.message);
    return success(c, { ok: true, storeUrl: tested.storeUrl });
  } catch (err) {
    return connectorErrorResponse(c, err);
  }
});

app.get('/connections/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  return success(c, await sanitizeConnectionWithEntity(row, keyringFromEnv(c.env)));
});

app.get('/connections/:id/runs', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100);
  const runs = await listSyncRuns(db, row.id, limit);
  return success(c, runs);
});

app.get('/connections/:id/records', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
  const records = await listConnectionRecords(db, row.id, limit);
  return success(c, records);
});

const patchSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  enabledSyncs: z.array(z.string().min(1)).optional(),
  credentials: z.record(z.string().min(1)).optional(),
  entityId: z.string().min(1).max(30).nullable().optional(),
});

app.patch(
  '/connections/:id',
  requirePermission('integrations:update'),
  zValidator('json', patchSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const row = await getConnectionById(db, c.req.param('id'));
    if (!row) return error.notFound(c, 'Connection', c.req.param('id'));

    const body = c.req.valid('json');
    const keyring = keyringFromEnv(c.env);

    try {
      if (body.entityId) {
        const [entity] = await db
          .select({ id: schema.entities.id })
          .from(schema.entities)
          .where(and(eq(schema.entities.id, body.entityId), isNull(schema.entities.deletedAt)))
          .limit(1);
        if (!entity) return error.badRequest(c, 'Accounting entity not found');
      }

      let encrypted: Record<string, string> | undefined;
      let externalAccountId: string | null | undefined;
      const existing = await decryptCredentials(row.credentials ?? undefined, keyring);

      if (body.credentials) {
        const merged = { ...existing, ...body.credentials };
        if (body.entityId) merged.entityId = body.entityId;
        else if (body.entityId === null) delete merged.entityId;
        const tested = await testProviderCredentials(row.provider, merged);
        if (!tested.ok) return error.badRequest(c, tested.message);
        encrypted = await encryptCredentials(merged, keyring);
        externalAccountId = tested.storeUrl;
      } else if (body.entityId !== undefined) {
        const merged = { ...existing };
        if (body.entityId) merged.entityId = body.entityId;
        else delete merged.entityId;
        encrypted = await encryptCredentials(merged, keyring);
      }

      await updateConnectionSettings({
        db,
        connectionId: row.id,
        enabledSyncs: body.enabledSyncs ? normalizeEnabledSyncs(row.provider, body.enabledSyncs) : undefined,
        credentials: encrypted,
        displayName: body.displayName,
        externalAccountId,
      });

      const updated = await getConnectionById(db, row.id);
      const clerkOrgId = c.get('workspaceId');
      if (updated && clerkOrgId) {
        try {
          const { id: internalWorkspaceId } = await getWorkspaceForOrg(c.env, clerkOrgId);
          await upsertConnectorIndexFromRow(c.env, {
            connection: updated,
            workspaceId: internalWorkspaceId,
            clerkOrgId,
            enabled: updated.status !== 'paused',
          });
        } catch (err) {
          console.warn('[app-api/connectors] D1 index upsert after patch failed:', err);
        }
      }
      publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'updated',
        entityId: row.id,
        data: (await sanitizeConnectionWithEntity(updated!, keyring)) as unknown as Record<string, unknown>,
      });
      return success(c, await sanitizeConnectionWithEntity(updated!, keyring));
    } catch (err) {
      console.error('[app-api/connectors] update failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

const syncNowSchema = z
  .object({
    full: z.boolean().optional(),
    syncs: z.array(z.string().min(1)).optional(),
  })
  .optional();

app.post(
  '/connections/:id/sync',
  requirePermission('integrations:update'),
  zValidator('json', syncNowSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const row = await getConnectionById(db, c.req.param('id'));
    if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
    if (row.status === 'paused') return error.badRequest(c, 'Connection is paused');

    const body = c.req.valid('json') ?? {};
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);

    try {
      c.executionCtx.waitUntil(
        syncConnection({
          db,
          env: c.env,
          connection: row,
          ownerId: c.get('userId'),
          workspaceId,
          trigger: 'manual',
          full: body.full ?? false,
          syncs: body.syncs,
        }).catch((err) => {
          console.error('[app-api/connectors] sync failed:', err);
        }),
      );

      publishEntityEvent({
        c,
        entityType: 'connector_connection',
        action: 'sync_started',
        entityId: row.id,
        data: {
          id: row.id,
          provider: row.provider,
          syncs: body.syncs ?? row.enabledSyncs,
          full: body.full ?? false,
        },
      });

      return success(c, { triggered: body.syncs ?? row.enabledSyncs ?? [], full: body.full ?? false });
    } catch (err) {
      console.error('[app-api/connectors] trigger sync failed:', err);
      return connectorErrorResponse(c, err);
    }
  },
);

app.post('/connections/:id/pause', requirePermission('integrations:update'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  await db
    .update(schema.connectorConnections)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(schema.connectorConnections.id, row.id));
  await setConnectorIndexEnabled(c.env, row.id, false);
  publishEntityEvent({
    c,
    entityType: 'connector_connection',
    action: 'paused',
    entityId: row.id,
    data: { id: row.id, provider: row.provider, status: 'paused' },
  });
  return success(c, { status: 'paused' });
});

app.post('/connections/:id/resume', requirePermission('integrations:update'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  await db
    .update(schema.connectorConnections)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(schema.connectorConnections.id, row.id));
  await setConnectorIndexEnabled(c.env, row.id, true);
  publishEntityEvent({
    c,
    entityType: 'connector_connection',
    action: 'resumed',
    entityId: row.id,
    data: { id: row.id, provider: row.provider, status: 'active' },
  });
  return success(c, { status: 'active' });
});

app.delete('/connections/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const row = await getConnectionById(db, c.req.param('id'));
  if (!row) return error.notFound(c, 'Connection', c.req.param('id'));
  const keyring = keyringFromEnv(c.env);
  try {
    const credentials = await decryptCredentials(row.credentials ?? undefined, keyring);
    await unregisterConnectionWebhooks({ connection: row, credentials });
  } catch (err) {
    console.error('[app-api/connectors] unregister webhooks failed:', err);
  }
  await deleteConnectorWebhookMapping(c.env, row.id);
  await markConnectionDisconnected(db, row.id);
  await removeConnectorIndex(c.env, row.id);
  publishEntityEvent({
    c,
    entityType: 'connector_connection',
    action: 'disconnected',
    entityId: row.id,
    data: { id: row.id, provider: row.provider },
  });
  return success(c, { id: row.id, disconnected: true });
});

export { app as connectorRoutes };
