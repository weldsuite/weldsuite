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
  getDefaultConnectorFieldMappings,
  listConnectors,
  WOOCOMMERCE_AUTH_CALLBACK_PATH,
} from '@weldsuite/connectors';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { getWorkspaceForOrg, schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
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
  seedDefaultConnectorFieldMappings,
  updateConnectionSettings,
  upsertConnection,
} from '@weldsuite/connect-domain/connectors/connections';
import { testConnectorCredentials } from '@weldsuite/connect-domain/connectors/clients';
import { syncConnection } from '@weldsuite/connect-domain/connectors/sync';
import { startWooCommerceAppAuth, startMoneybirdOAuth, completeMoneybirdOAuth, selectMoneybirdAdministration } from '@weldsuite/connect-domain/connectors/auth';
import {
  deleteConnectorWebhookMapping,
  putConnectorWebhookMapping,
  registerConnectionWebhooks,
  unregisterConnectionWebhooks,
} from '@weldsuite/connect-domain/connectors/webhooks';
import { and, eq, isNull } from 'drizzle-orm';
import { originForPathFrom } from '@weldsuite/api-modules';
import {
  removeConnectorIndex,
  setConnectorIndexEnabled,
  upsertConnectorIndexFromRow,
} from '@weldsuite/connect-domain/connector-sync-index';

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

function testProviderCredentials(
  provider: string,
  credentials: Record<string, string>,
): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
  return testConnectorCredentials(provider, credentials);
}

type ConnectorDefinition = NonNullable<ReturnType<typeof getConnector>>;
type ConnectionRow = NonNullable<Awaited<ReturnType<typeof getConnectionById>>>;
type Keyring = ReturnType<typeof keyringFromEnv>;

/** Why a direct connect request cannot proceed for this connector, or null when it can. */
function connectRequestError(
  connector: ConnectorDefinition,
  credentials: Record<string, string>,
): string | null {
  if (connector.auth.kind === 'oauth2') {
    return 'Connect this administration from the Connect button — Moneybird authorises via OAuth';
  }
  if (connector.auth.kind === 'app_auth' && (!credentials.consumerKey || !credentials.consumerSecret)) {
    return 'Connect this store from the Connect button — WooCommerce creates the API keys after you approve access';
  }
  for (const field of connector.auth.fields) {
    if ((field.required ?? true) && !credentials[field.key]?.trim()) {
      return `${field.label} is required`;
    }
  }
  return null;
}

/** Host part of a store URL, falling back to the raw value when it does not parse. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function accountingEntityExists(db: Database, entityId: string): Promise<boolean> {
  const [entity] = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  return Boolean(entity);
}

/** Registers a fresh connection in the webhook KV mapping and the D1 index (best effort). */
async function indexNewConnection(
  env: Env,
  clerkOrgId: string,
  connection: ConnectionRow,
  provider: string,
): Promise<void> {
  try {
    const { id: internalWorkspaceId } = await getWorkspaceForOrg(env, clerkOrgId);
    await putConnectorWebhookMapping({
      env,
      connectionId: connection.id,
      workspaceId: internalWorkspaceId,
      provider,
    });
    await upsertConnectorIndexFromRow(env, {
      connection,
      workspaceId: internalWorkspaceId,
      clerkOrgId,
      enabled: true,
    });
  } catch (err) {
    console.error('[app-api/connectors] webhook KV mapping failed:', err);
  }
}

/** Refreshes the D1 index row after a settings patch (best effort). */
async function refreshConnectorIndex(
  env: Env,
  clerkOrgId: string,
  connection: ConnectionRow,
): Promise<void> {
  try {
    const { id: internalWorkspaceId } = await getWorkspaceForOrg(env, clerkOrgId);
    await upsertConnectorIndexFromRow(env, {
      connection,
      workspaceId: internalWorkspaceId,
      clerkOrgId,
      enabled: connection.status !== 'paused',
    });
  } catch (err) {
    console.warn('[app-api/connectors] D1 index upsert after patch failed:', err);
  }
}

interface CredentialPatch {
  encrypted?: Record<string, string>;
  externalAccountId?: string;
  error?: string;
}

/**
 * Re-encrypts stored credentials after a PATCH: merges new credentials (and
 * re-tests them) and/or applies an accounting entity change.
 */
async function buildCredentialPatch(
  provider: string,
  existing: Awaited<ReturnType<typeof decryptCredentials>>,
  body: { credentials?: Record<string, string>; entityId?: string | null },
  keyring: Keyring,
): Promise<CredentialPatch> {
  if (body.credentials) {
    const merged = { ...existing, ...body.credentials };
    if (body.entityId) merged.entityId = body.entityId;
    else if (body.entityId === null) delete merged.entityId;
    const tested = await testProviderCredentials(provider, merged);
    if (!tested.ok) return { error: tested.message };
    return { encrypted: await encryptCredentials(merged, keyring), externalAccountId: tested.storeUrl };
  }
  if (body.entityId === undefined) return {};
  const merged = { ...existing };
  if (body.entityId) merged.entityId = body.entityId;
  else delete merged.entityId;
  return { encrypted: await encryptCredentials(merged, keyring) };
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
    return success(c, rows.map((row) => sanitizeConnection(row)));
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

  const requestError = connectRequestError(connector, credentials);
  if (requestError) return error.badRequest(c, requestError);

  try {
    const tested = await testProviderCredentials(provider, credentials);
    if (!tested.ok) return error.badRequest(c, tested.message);

    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const clerkOrgId = c.get('workspaceId');
    const keyring = keyringFromEnv(c.env);
    const encrypted = await encryptCredentials(credentials, keyring);
    const syncs = normalizeEnabledSyncs(provider, enabledSyncs);
    const label = displayName?.trim() || `${connector.label} (${hostnameOf(tested.storeUrl)})`;
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
    await seedDefaultConnectorFieldMappings(db, row.id, provider);

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

    if (clerkOrgId) await indexNewConnection(c.env, clerkOrgId, row, provider);

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
      if (body.entityId && !(await accountingEntityExists(c.get('tenantDb'), body.entityId))) {
        return error.badRequest(c, 'Accounting entity not found');
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
      // The callback path belongs to commerce-api; this worker's own host would 404.
      requestOrigin: originForPathFrom(new URL(c.req.url).origin, WOOCOMMERCE_AUTH_CALLBACK_PATH),
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
  direction: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
  objectSyncDirections: z
    .record(z.enum(['inbound', 'outbound', 'bidirectional']))
    .nullable()
    .optional(),
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
      if (body.entityId && !(await accountingEntityExists(db, body.entityId))) {
        return error.badRequest(c, 'Accounting entity not found');
      }

      const existing = await decryptCredentials(row.credentials ?? undefined, keyring);
      const credentialPatch = await buildCredentialPatch(row.provider, existing, body, keyring);
      if (credentialPatch.error) return error.badRequest(c, credentialPatch.error);

      await updateConnectionSettings({
        db,
        connectionId: row.id,
        enabledSyncs: body.enabledSyncs ? normalizeEnabledSyncs(row.provider, body.enabledSyncs) : undefined,
        direction: body.direction,
        objectSyncDirections: body.objectSyncDirections,
        credentials: credentialPatch.encrypted,
        displayName: body.displayName,
        externalAccountId: credentialPatch.externalAccountId,
      });

      const updated = await getConnectionById(db, row.id);
      const clerkOrgId = c.get('workspaceId');
      if (updated && clerkOrgId) await refreshConnectorIndex(c.env, clerkOrgId, updated);
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

// ============================================================================
// Field mappings (reuse integration_field_mappings, keyed by connector connection id)
// ============================================================================

app.get('/connections/:id/field-mappings', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const row = await getConnectionById(db, id);
  if (!row) return error.notFound(c, 'Connection', id);

  const entityType = c.req.query('entityType');
  const fm = schema.integrationFieldMappings;
  const conditions = [eq(fm.connectionId, id)];
  if (entityType) conditions.push(eq(fm.entityType, entityType));

  try {
    const mappings = await db.select().from(fm).where(and(...conditions));
    return success(c, mappings);
  } catch (err) {
    console.error('[app-api/connectors] field mappings failed:', err);
    return error.internal(c, 'Failed to fetch field mappings');
  }
});

app.get('/connections/:id/field-mappings/defaults', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const entityType = c.req.query('entityType');
  if (!entityType) return error.badRequest(c, 'entityType query param required');

  const row = await getConnectionById(db, id);
  if (!row) return error.notFound(c, 'Connection', id);

  return success(c, getDefaultConnectorFieldMappings(entityType, row.provider));
});

const updateConnectorFieldMappingsSchema = z.object({
  entityType: z.string().min(1),
  mappings: z.array(
    z.object({
      externalFieldPath: z.string().min(1),
      internalFieldPath: z.string().min(1),
      direction: z.enum(['inbound', 'outbound', 'bidirectional']).default('bidirectional'),
      transformType: z.enum(['direct', 'lookup', 'format_date', 'custom']).default('direct'),
      transformConfig: z.record(z.unknown()).optional(),
      isRequired: z.boolean().default(false),
    }),
  ),
});

app.put(
  '/connections/:id/field-mappings',
  requirePermission('integrations:update'),
  zValidator('json', updateConnectorFieldMappingsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const row = await getConnectionById(db, id);
    if (!row) return error.notFound(c, 'Connection', id);

    const { entityType, mappings } = c.req.valid('json');
    const fm = schema.integrationFieldMappings;

    try {
      await db.delete(fm).where(and(eq(fm.connectionId, id), eq(fm.entityType, entityType)));

      if (mappings.length > 0) {
        await db.insert(fm).values(
          mappings.map((m, i) => ({
            id: generateId('ifm'),
            connectionId: id,
            entityType,
            externalFieldPath: m.externalFieldPath,
            internalFieldPath: m.internalFieldPath,
            direction: m.direction,
            transformType: m.transformType,
            transformConfig: m.transformConfig,
            isRequired: m.isRequired,
            isDefault: false,
            position: i,
          })),
        );
      }

      return success(c, { entityType, count: mappings.length });
    } catch (err) {
      console.error('[app-api/connectors] update field mappings failed:', err);
      return error.internal(c, 'Failed to update field mappings');
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

const picqerPushSchema = z.object({
  entity: z.enum([
    'person',
    'order',
    'supplier',
    'warehouse',
    'purchase_order',
    'return',
    'inventory',
  ]),
  entityId: z.string().min(1),
  warehouseId: z.string().optional(),
  amountDelta: z.number().optional(),
});

app.post(
  '/connections/:id/picqer/push',
  requirePermission('integrations:update'),
  zValidator('json', picqerPushSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const row = await getConnectionById(db, id);
    if (!row) return error.notFound(c, 'Connection', id);
    if (row.provider !== 'picqer') return error.badRequest(c, 'Not a Picqer connection');

    const body = c.req.valid('json');
    try {
      const {
        pushOrderToPicqer,
        pushPersonToPicqer,
        pushPurchaseOrderToPicqer,
        pushReturnToPicqer,
        pushStockAdjustmentToPicqer,
        pushSupplierToPicqer,
        pushWarehouseToPicqer,
      } = await import('../../services/connectors/publish-picqer');

      if (body.entity === 'person') {
        return success(c, await pushPersonToPicqer({ db, env: c.env, connectionId: id, personId: body.entityId }));
      }
      if (body.entity === 'order') {
        return success(c, await pushOrderToPicqer({ db, env: c.env, connectionId: id, orderId: body.entityId }));
      }
      if (body.entity === 'supplier') {
        return success(c, await pushSupplierToPicqer({ db, env: c.env, connectionId: id, supplierId: body.entityId }));
      }
      if (body.entity === 'warehouse') {
        return success(c, await pushWarehouseToPicqer({ db, env: c.env, connectionId: id, warehouseId: body.entityId }));
      }
      if (body.entity === 'purchase_order') {
        return success(
          c,
          await pushPurchaseOrderToPicqer({ db, env: c.env, connectionId: id, purchaseOrderId: body.entityId }),
        );
      }
      if (body.entity === 'return') {
        return success(c, await pushReturnToPicqer({ db, env: c.env, connectionId: id, returnId: body.entityId }));
      }
      if (body.entity === 'inventory') {
        if (!body.warehouseId || body.amountDelta === undefined) {
          return error.badRequest(c, 'warehouseId and amountDelta required for inventory push');
        }
        await pushStockAdjustmentToPicqer({
          db,
          env: c.env,
          connectionId: id,
          productId: body.entityId,
          warehouseId: body.warehouseId,
          amountDelta: body.amountDelta,
        });
        return success(c, { ok: true });
      }
      return error.badRequest(c, 'Unsupported entity');
    } catch (err) {
      console.error('[app-api/connectors] picqer push failed:', err);
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
