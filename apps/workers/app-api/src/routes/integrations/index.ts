/**
 * Integration routes — flat /api/integrations/* surface backed by `integrationConnections`.
 *
 * Two families live here:
 *  - The original app-api object CRUD (GET /, GET /:id, POST /, PATCH /:id,
 *    DELETE /:id) kept for compatibility with the shared schemas client.
 *  - The legacy api-worker `/api/integrations/connections/*` surface ported in
 *    W3/W4 of the legacy-worker phase-out: connection CRUD, MCP tool discovery,
 *    OAuth connect flows (Attio + generic provider registry: HubSpot, Google
 *    Calendar), manual sync + Google Calendar watch renewal, sync logs, field
 *    mappings, conflict management and entity-mapping lookups.
 *
 * The CRM sync engine itself is the CrmSyncWorkflow HOSTED BY
 * integration-webhook-worker (crm-sync-int*); app-api only dispatches it via
 * the cross-script CRM_SYNC binding (see services/integrations/connections.ts).
 *
 * NOTE on ordering: every static `/connections*` and `/entity-mappings` route
 * MUST be registered before the generic `/:id` handlers at the bottom, or
 * `/:id` would swallow them.
 *
 * Permissions: integrations:read | integrations:create | integrations:update | integrations:delete.
 * Entity events: `integration_connection` is not in the @weldsuite/entity-events
 * catalog — no publishEntityEvent calls here (flagged in the port report).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createIntegrationSchema, updateIntegrationSchema } from '@weldsuite/core-api-client/schemas/integrations';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getWorkspaceForOrg, schema } from '../../db';
import {
  getWebhookWorkerUrl,
  triggerConnectionSync,
  triggerCrmSync,
  renewGoogleCalendarWatch,
  type IntegrationsEnv,
} from '../../services/integrations/connections';
import { getOAuthAdapter, hasOAuthAdapter } from '../../services/integrations/oauth-providers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.integrationConnections;

/** Resolve `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET` from env. */
function providerCredentials(env: Env, provider: string): { clientId?: string; clientSecret?: string } {
  const bag = env as unknown as Record<string, string | undefined>;
  return {
    clientId: bag[`${provider.toUpperCase()}_CLIENT_ID`],
    clientSecret: bag[`${provider.toUpperCase()}_CLIENT_SECRET`],
  };
}

// ============================================================================
// Object CRUD list (cursor-paginated) — pre-existing app-api surface
// ============================================================================

app.get('/', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.provider !== undefined && q.provider !== '') conditions.push(eq(t.provider, q.provider as never));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status as never));
  // Snapshot filter conditions BEFORE the cursor predicate is pushed.
  const filterConditions = [...conditions];
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/integrations] list failed:', err);
    return error.internal(c, 'Failed to list integrations');
  }
});

// ============================================================================
// Connections — list / get (legacy api-worker surface)
// ============================================================================

app.get('/connections', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const connections = await db
      .select()
      .from(t)
      .where(isNull(t.deletedAt))
      .orderBy(desc(t.createdAt));

    // Strip sensitive fields from response
    const sanitized = connections.map((conn) => ({
      ...conn,
      oauthTokens: undefined,
      webhookSecret: undefined,
    }));

    return success(c, sanitized);
  } catch (err) {
    console.error('[app-api/integrations] connections list failed:', err);
    return error.internal(c, 'Failed to list connections');
  }
});

// ============================================================================
// Connections — create (generic: MCP servers and future providers)
// ============================================================================

const createConnectionSchema = z.object({
  provider: z.enum(['mcp_server']),
  name: z.string().min(1).max(255),
  settings: z.object({
    transportType: z.enum(['streamable-http', 'sse', 'stdio']),
    url: z.string().url().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    authType: z.enum(['none', 'bearer', 'api_key', 'header']).optional(),
    headerName: z.string().optional(),
  }),
  accessToken: z.string().optional(),
});

app.post('/connections', requirePermission('integrations:create'), zValidator('json', createConnectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { provider, name, settings, accessToken } = c.req.valid('json');

  try {
    const connectionId = generateId('intc');
    const oauthTokens = accessToken ? { accessToken } : undefined;

    await db.insert(t).values({
      id: connectionId,
      provider,
      name,
      status: 'active',
      direction: 'bidirectional',
      settings,
      oauthTokens,
      connectedAt: new Date(),
      connectedBy: userId,
    } as unknown as typeof t.$inferInsert);

    return success(c, {
      id: connectionId,
      provider,
      name,
      status: 'active',
      connectedAt: new Date().toISOString(),
    }, 201);
  } catch (err) {
    console.error('[app-api/integrations] create connection failed:', err);
    return error.internal(c, 'Failed to create connection');
  }
});

// ============================================================================
// Attio OAuth: authorize + callback (state key kept as attio_oauth_state:*)
// ============================================================================

const authorizeSchema = z.object({
  redirectUri: z.string().url(),
});

app.post('/connections/attio/authorize', requirePermission('integrations:create'), zValidator('json', authorizeSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const env = c.env as IntegrationsEnv;

  const { redirectUri } = c.req.valid('json');

  const clientId = env.ATTIO_CLIENT_ID;
  if (!clientId) return error.internal(c, 'Attio client ID not configured');

  try {
    // Generate state and store in KV (5 min TTL)
    const state = crypto.randomUUID();
    await env.WORKSPACE_CACHE.put(
      `attio_oauth_state:${state}`,
      JSON.stringify({ orgId, userId: c.get('userId') }),
      { expirationTtl: 300 },
    );

    const authorizeUrl = getOAuthAdapter('attio').getAuthorizeUrl(clientId, redirectUri, state);
    return success(c, { authorizeUrl, state });
  } catch (err) {
    console.error('[app-api/integrations] attio authorize failed:', err);
    return error.internal(c, 'Failed to start Attio OAuth');
  }
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().url(),
});

app.post('/connections/attio/callback', requirePermission('integrations:create'), zValidator('json', callbackSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const env = c.env as IntegrationsEnv;
  const db = c.get('tenantDb');

  const { code, state, redirectUri } = c.req.valid('json');

  try {
    // 1. Validate state from KV
    const stateKey = `attio_oauth_state:${state}`;
    const stateData = (await env.WORKSPACE_CACHE.get(stateKey, 'json')) as { orgId: string; userId: string } | null;

    if (!stateData || stateData.orgId !== orgId) {
      return error.badRequest(c, 'Invalid or expired OAuth state');
    }
    await env.WORKSPACE_CACHE.delete(stateKey);

    const clientId = env.ATTIO_CLIENT_ID;
    const clientSecret = env.ATTIO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return error.internal(c, 'Attio credentials not configured');
    }

    const adapter = getOAuthAdapter('attio');

    // 2. Exchange code for tokens
    const tokens = await adapter.exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);

    // 3. Create connection record
    const connectionId = generateId('intc');
    const webhookTargetUrl = `${getWebhookWorkerUrl(env)}/webhook/${connectionId}`;

    // 4. Register webhooks at Attio
    const webhookReg = await adapter.registerWebhooks(tokens.accessToken, webhookTargetUrl, adapter.supportedEntities);

    // 5. Insert connection
    await db.insert(t).values({
      id: connectionId,
      provider: 'attio',
      name: 'Attio CRM',
      status: 'active',
      direction: 'inbound',
      oauthTokens: tokens,
      webhookId: webhookReg.webhookId,
      webhookSecret: webhookReg.secret,
      syncSettings: { syncCompanies: true, syncPeople: true, syncIntervalHours: 6 },
      connectedAt: new Date(),
      connectedBy: stateData.userId,
    } as unknown as typeof t.$inferInsert);

    // 6. Store KV mapping: connectionId → workspaceId (for webhook worker).
    //    MUST be the INTERNAL workspace id, not the Clerk org id: every reader
    //    (integration-webhook-worker's getTenantDbForWorkspaceById, and the
    //    X-Internal-Workspace-Id header it forwards to routes/integrations/
    //    internal.ts) looks the value up against `workspaces.id`. Note
    //    `c.get('workspaceId')` is the CLERK ORG id (middleware/workspace-db.ts)
    //    — using it here 500s every inbound Attio webhook. The KV namespace is
    //    shared with api-worker, so a wrong value poisons that keyspace too.
    const { id: internalWorkspaceId } = await getWorkspaceForOrg(c.env, orgId);
    await env.WORKSPACE_CACHE.put(
      `intconn:${connectionId}`,
      JSON.stringify({ workspaceId: internalWorkspaceId, provider: 'attio' }),
      { expirationTtl: 86400 * 365 }, // Long TTL (renewed on sync)
    );

    // 7. Trigger initial full sync via the CRM_SYNC workflow (non-fatal)
    try {
      await triggerCrmSync(env, {
        connectionId,
        workspaceId: orgId,
        provider: 'attio',
        syncType: 'full',
      });
    } catch (triggerErr) {
      console.error('[app-api/integrations] failed to trigger initial Attio sync:', triggerErr);
    }

    return success(c, {
      id: connectionId,
      provider: 'attio',
      status: 'active',
      connectedAt: new Date().toISOString(),
    }, 201);
  } catch (err) {
    console.error('[app-api/integrations] attio callback failed:', err);
    return error.internal(c, err instanceof Error ? err.message : 'OAuth callback failed');
  }
});

// ============================================================================
// Generic OAuth: authorize + callback (HubSpot, Google Calendar, ...)
// Registered AFTER the attio-specific routes so those keep their KV state key.
// ============================================================================

app.post('/connections/:provider/authorize', requirePermission('integrations:create'), zValidator('json', authorizeSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const env = c.env as IntegrationsEnv;

  const provider = c.req.param('provider');
  const { redirectUri } = c.req.valid('json');

  if (!hasOAuthAdapter(provider)) {
    return error.badRequest(c, `Provider ${provider} is not supported`);
  }

  const { clientId } = providerCredentials(env, provider);
  if (!clientId) {
    return error.badRequest(c, `Provider ${provider} is not configured`);
  }

  try {
    const state = crypto.randomUUID();
    await env.WORKSPACE_CACHE.put(
      `oauth_state:${state}`,
      JSON.stringify({ orgId, userId: c.get('userId'), provider }),
      { expirationTtl: 300 },
    );

    const authorizeUrl = getOAuthAdapter(provider).getAuthorizeUrl(clientId, redirectUri, state);
    return success(c, { authorizeUrl, state });
  } catch (err) {
    console.error('[app-api/integrations] generic authorize failed:', err);
    return error.internal(c, 'Failed to start OAuth');
  }
});

app.post('/connections/:provider/callback', requirePermission('integrations:create'), zValidator('json', callbackSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const env = c.env as IntegrationsEnv;
  const db = c.get('tenantDb');

  const provider = c.req.param('provider');
  const { code, state, redirectUri } = c.req.valid('json');

  if (!hasOAuthAdapter(provider)) {
    return error.badRequest(c, `Provider ${provider} is not supported`);
  }

  try {
    const stateKey = `oauth_state:${state}`;
    const stateData = (await env.WORKSPACE_CACHE.get(stateKey, 'json')) as {
      orgId: string;
      userId: string;
      provider: string;
    } | null;

    if (!stateData || stateData.orgId !== orgId || stateData.provider !== provider) {
      return error.badRequest(c, 'Invalid or expired OAuth state');
    }
    await env.WORKSPACE_CACHE.delete(stateKey);

    const { clientId, clientSecret } = providerCredentials(env, provider);
    if (!clientId || !clientSecret) {
      return error.internal(c, `${provider} credentials not configured`);
    }

    const adapter = getOAuthAdapter(provider);
    const tokens = await adapter.exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);

    const connectionId = generateId('intc');
    const isGoogleCalendar = provider === 'google_calendar';

    // Google Calendar uses a dedicated webhook path with gcal/ prefix
    const webhookPath = isGoogleCalendar ? `gcal/${connectionId}` : connectionId;
    const webhookTargetUrl = `${getWebhookWorkerUrl(env)}/webhook/${webhookPath}`;

    // Register webhooks
    const webhookReg = await adapter.registerWebhooks(tokens.accessToken, webhookTargetUrl, adapter.supportedEntities);

    // Insert default field mappings (skip for Google Calendar — hardcoded transforms)
    const fieldMappingValues: (typeof schema.integrationFieldMappings.$inferInsert)[] = [];
    if (!isGoogleCalendar) {
      for (const entityType of adapter.supportedEntities) {
        const defaults = adapter.getDefaultFieldMappings(entityType);
        for (let i = 0; i < defaults.length; i++) {
          const mapping = defaults[i];
          fieldMappingValues.push({
            id: generateId('ifm'),
            connectionId,
            entityType,
            externalFieldPath: mapping.externalFieldPath,
            internalFieldPath: mapping.internalFieldPath,
            direction: mapping.direction,
            transformType: mapping.transformType,
            transformConfig: mapping.transformConfig,
            isRequired: mapping.isRequired || false,
            isDefault: true,
            position: i,
          } as typeof schema.integrationFieldMappings.$inferInsert);
        }
      }
    }

    // For HubSpot, use the client secret for webhook signature verification
    const webhookSecret = provider === 'hubspot' ? clientSecret : webhookReg.secret;

    // For HubSpot: get the portal ID (hub_id) for webhook routing
    let externalAccountId: string | undefined;
    if (provider === 'hubspot') {
      try {
        const tokenInfoRes = await fetch('https://api.hubapi.com/oauth/v1/access-tokens/' + tokens.accessToken);
        if (tokenInfoRes.ok) {
          const tokenInfo = (await tokenInfoRes.json()) as { hub_id: number };
          if (tokenInfo.hub_id) externalAccountId = String(tokenInfo.hub_id);
        }
      } catch (err) {
        console.warn('[app-api/integrations] failed to get HubSpot portal ID:', err);
      }
    }

    // For Google Calendar: create a WeldSuite calendar container for synced events
    let googleCalendarSettings: Record<string, unknown> | undefined;
    if (isGoogleCalendar) {
      const calId = generateId('cal');
      await db.insert(schema.calendars).values({
        id: calId,
        name: 'Google Calendar',
        color: '#4285f4',
        ownerId: stateData.userId,
        isDefault: false,
      } as unknown as typeof schema.calendars.$inferInsert);
      googleCalendarSettings = { googleCalendarId: calId };
    }

    // Insert connection
    await db.insert(t).values({
      id: connectionId,
      provider,
      name: isGoogleCalendar ? 'Google Calendar' : `${provider.charAt(0).toUpperCase() + provider.slice(1)} CRM`,
      status: 'active',
      direction: isGoogleCalendar ? 'bidirectional' : 'inbound',
      externalAccountId,
      oauthTokens: tokens,
      webhookId: webhookReg.webhookId,
      webhookSecret,
      settings: googleCalendarSettings,
      syncSettings: isGoogleCalendar
        ? { syncCalendarEvents: true, syncIntervalHours: 1 }
        : { syncCompanies: true, syncPeople: true, syncIntervalHours: 6 },
      connectedAt: new Date(),
      connectedBy: stateData.userId,
    } as unknown as typeof t.$inferInsert);

    // Insert field mappings
    if (fieldMappingValues.length > 0) {
      await db.insert(schema.integrationFieldMappings).values(fieldMappingValues);
    }

    // Store KV mapping for webhook worker — INTERNAL workspace id, not the
    // Clerk org id that `c.get('workspaceId')` holds. See the Attio callback
    // above: readers resolve it against `workspaces.id`, and the Google
    // Calendar push path additionally forwards it as X-Internal-Workspace-Id
    // to routes/integrations/internal.ts, which resolves it the same way.
    const { id: internalWorkspaceId } = await getWorkspaceForOrg(c.env, orgId);
    await env.WORKSPACE_CACHE.put(
      `intconn:${connectionId}`,
      JSON.stringify({ workspaceId: internalWorkspaceId, provider }),
      { expirationTtl: 86400 * 365 },
    );

    // Trigger initial sync (non-fatal)
    try {
      await triggerCrmSync(env, {
        connectionId,
        workspaceId: orgId,
        provider,
        syncType: 'full',
      });
    } catch (triggerErr) {
      console.error('[app-api/integrations] failed to trigger initial sync:', triggerErr);
    }

    return success(c, {
      id: connectionId,
      provider,
      status: 'active',
      connectedAt: new Date().toISOString(),
    }, 201);
  } catch (err) {
    console.error('[app-api/integrations] generic callback failed:', err);
    return error.internal(c, err instanceof Error ? err.message : 'OAuth callback failed');
  }
});

// ============================================================================
// Connections — get details (with recent sync logs)
// ============================================================================

app.get('/connections/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);

    const logs = await db
      .select()
      .from(schema.syncLogs)
      .where(eq(schema.syncLogs.connectionId, id))
      .orderBy(desc(schema.syncLogs.createdAt))
      .limit(20);

    return success(c, {
      ...connection,
      oauthTokens: undefined,
      webhookSecret: undefined,
      recentLogs: logs,
    });
  } catch (err) {
    console.error('[app-api/integrations] connection get failed:', err);
    return error.internal(c, 'Failed to fetch connection');
  }
});

// ============================================================================
// Connections — update (MCP settings, sync settings)
// ============================================================================

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  settings: z.object({
    transportType: z.enum(['streamable-http', 'sse', 'stdio']).optional(),
    url: z.string().url().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    authType: z.enum(['none', 'bearer', 'api_key', 'header']).optional(),
    headerName: z.string().optional(),
  }).optional(),
  accessToken: z.string().optional(),
  syncSettings: z.object({
    syncCompanies: z.boolean().optional(),
    syncPeople: z.boolean().optional(),
    syncLeads: z.boolean().optional(),
    syncOpportunities: z.boolean().optional(),
    syncActivities: z.boolean().optional(),
    syncIntervalHours: z.number().min(1).max(168).optional(),
  }).optional(),
});

app.patch('/connections/:id', requirePermission('integrations:update'), zValidator('json', updateConnectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name) updates.name = body.name;

    if (body.settings) {
      const currentSettings = (connection.settings || {}) as Record<string, unknown>;
      updates.settings = { ...currentSettings, ...body.settings };
    }

    if (body.accessToken !== undefined) {
      updates.oauthTokens = body.accessToken ? { accessToken: body.accessToken } : null;
    }

    if (body.syncSettings) {
      const currentSyncSettings = (connection.syncSettings || {}) as Record<string, unknown>;
      updates.syncSettings = { ...currentSyncSettings, ...body.syncSettings };
    }

    await db.update(t).set(updates as Partial<typeof t.$inferInsert>).where(eq(t.id, id));

    return success(c, { id, updated: true });
  } catch (err) {
    console.error('[app-api/integrations] connection update failed:', err);
    return error.internal(c, 'Failed to update connection');
  }
});

// ============================================================================
// Connections — disconnect (webhook cleanup + KV unmap + soft-delete)
// ============================================================================

app.delete('/connections/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const env = c.env as IntegrationsEnv;
  const id = c.req.param('id');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);

    // 1. Delete webhooks at provider (non-fatal)
    const tokens = connection.oauthTokens as { accessToken: string } | null;
    if (tokens?.accessToken && connection.webhookId && hasOAuthAdapter(connection.provider)) {
      try {
        const adapter = getOAuthAdapter(connection.provider);
        await adapter.deleteWebhooks(tokens.accessToken, connection.webhookId, connection.webhookSecret || undefined);
      } catch (delErr) {
        console.warn('[app-api/integrations] failed to delete remote webhooks:', delErr);
      }
    }

    // 2. Remove KV mapping
    await env.WORKSPACE_CACHE.delete(`intconn:${id}`);

    // 3. Soft-delete connection
    await db
      .update(t)
      .set({ status: 'inactive', deletedAt: new Date(), updatedAt: new Date() } as Partial<typeof t.$inferInsert>)
      .where(eq(t.id, id));

    return noContent(c);
  } catch (err) {
    console.error('[app-api/integrations] disconnect failed:', err);
    return error.internal(c, 'Failed to disconnect');
  }
});

// ============================================================================
// Connections — MCP tool discovery
// ============================================================================

app.post('/connections/:id/discover-tools', requirePermission('integrations:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);

    if (connection.provider !== 'mcp_server') {
      return error.badRequest(c, 'Tool discovery is only supported for MCP server integrations');
    }

    const settings = (connection.settings || {}) as Record<string, unknown>;
    const url = settings.url as string | undefined;

    if (!url) return error.badRequest(c, 'No URL configured for this MCP server');

    // Build auth headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const authType = settings.authType as string | undefined;
    const oauthTokens = connection.oauthTokens as { accessToken?: string } | null;
    const token = oauthTokens?.accessToken;

    if (authType === 'bearer' && token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (authType === 'api_key' && token) {
      headers['X-API-Key'] = token;
    } else if (authType === 'header' && settings.headerName && token) {
      headers[settings.headerName as string] = token;
    }

    // Call MCP server tools/list via JSON-RPC 2.0
    let discoveredTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    try {
      const rpcResponse = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!rpcResponse.ok) {
        const text = await rpcResponse.text();
        return error.badRequest(c, `MCP server returned ${rpcResponse.status}: ${text.slice(0, 200)}`);
      }

      const rpcResult = (await rpcResponse.json()) as {
        result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
        error?: { message: string };
      };

      if (rpcResult.error) {
        return error.badRequest(c, `MCP server error: ${rpcResult.error.message}`);
      }

      discoveredTools = (rpcResult.result?.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
      }));
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : 'Connection failed';
      return error.badRequest(c, `Failed to connect to MCP server: ${msg}`);
    }

    // Cache discovered tools in settings
    const now = new Date().toISOString();
    await db
      .update(t)
      .set({
        settings: { ...settings, discoveredTools, lastDiscoveredAt: now },
        status: 'active',
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      } as Partial<typeof t.$inferInsert>)
      .where(eq(t.id, id));

    return success(c, { tools: discoveredTools, lastDiscoveredAt: now });
  } catch (err) {
    console.error('[app-api/integrations] discover tools failed:', err);
    return error.internal(c, 'Failed to discover tools');
  }
});

// ============================================================================
// Connections — connectivity test
// ============================================================================

app.post('/connections/:id/test', requirePermission('integrations:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);

    if (connection.provider === 'mcp_server') {
      const settings = (connection.settings || {}) as Record<string, unknown>;
      const url = settings.url as string | undefined;

      if (!url) return success(c, { connected: false, error: 'No URL configured' });

      // Simple connectivity test — HEAD request to the MCP server URL
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);

        const connected = response.ok || response.status === 405; // 405 is fine — MCP servers may not support HEAD

        await db
          .update(t)
          .set({
            status: connected ? 'active' : 'error',
            lastError: connected ? null : `HTTP ${response.status}`,
            lastErrorAt: connected ? null : new Date(),
            updatedAt: new Date(),
          } as Partial<typeof t.$inferInsert>)
          .where(eq(t.id, id));

        return success(c, { connected, status: response.status });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Connection failed';

        await db
          .update(t)
          .set({
            status: 'error',
            lastError: errorMsg,
            lastErrorAt: new Date(),
            updatedAt: new Date(),
          } as Partial<typeof t.$inferInsert>)
          .where(eq(t.id, id));

        return success(c, { connected: false, error: errorMsg });
      }
    }

    return success(c, { connected: true, message: 'Test not implemented for this provider' });
  } catch (err) {
    console.error('[app-api/integrations] connection test failed:', err);
    return error.internal(c, 'Failed to test connection');
  }
});

// ============================================================================
// Connections — trigger manual sync
// ============================================================================

app.post('/connections/:id/sync', requirePermission('integrations:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const env = c.env as IntegrationsEnv;
  const id = c.req.param('id');

  try {
    const result = await triggerConnectionSync(db, env, orgId, id);
    if (!result.ok) {
      if (result.code === 'not_found') return error.notFound(c, 'Connection', id);
      if (result.code === 'conflict') return error.conflict(c, result.message);
      return error.badRequest(c, result.message);
    }
    return success(c, { message: result.message });
  } catch (err) {
    console.error('[app-api/integrations] sync trigger failed:', err);
    return error.internal(c, 'Failed to trigger sync');
  }
});

// ============================================================================
// Connections — renew Google Calendar watch channel
// ============================================================================

app.post('/connections/:id/renew-watch', requirePermission('integrations:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const env = c.env as IntegrationsEnv;
  const id = c.req.param('id');

  try {
    const result = await renewGoogleCalendarWatch(db, env, id);
    if (!result.ok) {
      if (result.code === 'not_found') return error.notFound(c, 'Connection', id);
      return error.internal(c, result.message);
    }
    return success(c, { message: result.message });
  } catch (err) {
    console.error('[app-api/integrations] watch renewal failed:', err);
    return error.internal(c, 'Failed to renew watch channel');
  }
});

// ============================================================================
// Connections — sync logs
// ============================================================================

app.get('/connections/:id/logs', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const logs = await db
      .select()
      .from(schema.syncLogs)
      .where(eq(schema.syncLogs.connectionId, id))
      .orderBy(desc(schema.syncLogs.createdAt))
      .limit(50);

    return success(c, logs);
  } catch (err) {
    console.error('[app-api/integrations] logs failed:', err);
    return error.internal(c, 'Failed to fetch sync logs');
  }
});

// ============================================================================
// Field mappings
// ============================================================================

app.get('/connections/:id/field-mappings', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const entityType = c.req.query('entityType');
  const fm = schema.integrationFieldMappings;

  try {
    const conditions = [eq(fm.connectionId, id)];
    if (entityType) conditions.push(eq(fm.entityType, entityType));

    const mappings = await db.select().from(fm).where(and(...conditions));
    return success(c, mappings);
  } catch (err) {
    console.error('[app-api/integrations] field mappings failed:', err);
    return error.internal(c, 'Failed to fetch field mappings');
  }
});

app.get('/connections/:id/field-mappings/defaults', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const entityType = c.req.query('entityType');
  if (!entityType) return error.badRequest(c, 'entityType query param required');

  try {
    const [connection] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!connection) return error.notFound(c, 'Connection', id);
    if (!hasOAuthAdapter(connection.provider)) {
      return error.badRequest(c, `Provider ${connection.provider} has no default field mappings`);
    }

    const adapter = getOAuthAdapter(connection.provider);
    const defaults = adapter.getDefaultFieldMappings(entityType as never);

    return success(c, defaults);
  } catch (err) {
    console.error('[app-api/integrations] default field mappings failed:', err);
    return error.internal(c, 'Failed to fetch default field mappings');
  }
});

const updateFieldMappingsSchema = z.object({
  entityType: z.string().min(1),
  mappings: z.array(z.object({
    externalFieldPath: z.string().min(1),
    internalFieldPath: z.string().min(1),
    direction: z.enum(['inbound', 'outbound', 'bidirectional']).default('bidirectional'),
    transformType: z.enum(['direct', 'lookup', 'format_date', 'custom']).default('direct'),
    transformConfig: z.record(z.unknown()).optional(),
    isRequired: z.boolean().default(false),
  })),
});

app.put('/connections/:id/field-mappings', requirePermission('integrations:update'), zValidator('json', updateFieldMappingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { entityType, mappings } = c.req.valid('json');
  const fm = schema.integrationFieldMappings;

  try {
    // Delete existing mappings for this entity type
    await db.delete(fm).where(and(eq(fm.connectionId, id), eq(fm.entityType, entityType)));

    // Insert new mappings
    if (mappings.length > 0) {
      const values = mappings.map((m, i) => ({
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
      } as typeof fm.$inferInsert));

      await db.insert(fm).values(values);
    }

    return success(c, { entityType, count: mappings.length });
  } catch (err) {
    console.error('[app-api/integrations] update field mappings failed:', err);
    return error.internal(c, 'Failed to update field mappings');
  }
});

// ============================================================================
// Conflict management
// ============================================================================

app.get('/connections/:id/conflicts', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const resolution = c.req.query('resolution') || 'pending';
  const entityType = c.req.query('entityType');
  const sc = schema.integrationSyncConflicts;

  try {
    const conditions = [
      eq(sc.connectionId, id),
      eq(sc.resolution, resolution as never),
    ];
    if (entityType) conditions.push(eq(sc.entityType, entityType));

    const conflicts = await db
      .select()
      .from(sc)
      .where(and(...conditions))
      .orderBy(desc(sc.createdAt))
      .limit(100);

    return success(c, conflicts);
  } catch (err) {
    console.error('[app-api/integrations] conflicts failed:', err);
    return error.internal(c, 'Failed to fetch conflicts');
  }
});

const resolveConflictSchema = z.object({
  resolution: z.enum(['keep_internal', 'keep_external', 'merged', 'dismissed']),
});

app.post('/connections/:id/conflicts/:conflictId/resolve', requirePermission('integrations:update'), zValidator('json', resolveConflictSchema), async (c) => {
  const db = c.get('tenantDb');
  const conflictId = c.req.param('conflictId');
  const { resolution } = c.req.valid('json');
  const userId = c.get('userId');
  const sc = schema.integrationSyncConflicts;

  try {
    await db
      .update(sc)
      .set({ resolution, resolvedAt: new Date(), resolvedBy: userId } as Partial<typeof sc.$inferInsert>)
      .where(eq(sc.id, conflictId));

    return success(c, { resolved: true });
  } catch (err) {
    console.error('[app-api/integrations] resolve conflict failed:', err);
    return error.internal(c, 'Failed to resolve conflict');
  }
});

const bulkResolveSchema = z.object({
  resolution: z.enum(['keep_internal', 'keep_external', 'dismissed']),
  entityType: z.string().optional(),
});

app.post('/connections/:id/conflicts/resolve-all', requirePermission('integrations:update'), zValidator('json', bulkResolveSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { resolution, entityType } = c.req.valid('json');
  const userId = c.get('userId');
  const sc = schema.integrationSyncConflicts;

  try {
    const conditions = [
      eq(sc.connectionId, id),
      eq(sc.resolution, 'pending' as never),
    ];
    if (entityType) conditions.push(eq(sc.entityType, entityType));

    await db
      .update(sc)
      .set({ resolution, resolvedAt: new Date(), resolvedBy: userId } as Partial<typeof sc.$inferInsert>)
      .where(and(...conditions));

    return success(c, { resolved: true });
  } catch (err) {
    console.error('[app-api/integrations] bulk resolve failed:', err);
    return error.internal(c, 'Failed to resolve conflicts');
  }
});

// ============================================================================
// Entity sync status lookup
// ============================================================================

app.get('/entity-mappings', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const internalEntityType = c.req.query('internalEntityType');
  const internalEntityId = c.req.query('internalEntityId');
  const em = schema.integrationEntityMappings;

  if (!internalEntityType || !internalEntityId) {
    return error.badRequest(c, 'internalEntityType and internalEntityId are required');
  }

  try {
    const mappings = await db
      .select()
      .from(em)
      .where(
        and(
          eq(em.internalEntityType, internalEntityType),
          eq(em.internalEntityId, internalEntityId),
        ),
      );

    return success(c, mappings);
  } catch (err) {
    console.error('[app-api/integrations] entity mappings failed:', err);
    return error.internal(c, 'Failed to fetch entity mappings');
  }
});

// ============================================================================
// Object CRUD by id — MUST stay LAST so `/:id` never swallows the static
// `/connections*` and `/entity-mappings` routes above.
// ============================================================================

app.get('/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Integration', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/integrations] get failed:', err);
    return error.internal(c, 'Failed to fetch integration');
  }
});

app.post('/', requirePermission('integrations:create'), zValidator('json', createIntegrationSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('int');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/integrations] create failed:', err);
    return error.internal(c, 'Failed to create integration');
  }
});

app.patch('/:id', requirePermission('integrations:update'), zValidator('json', updateIntegrationSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Integration', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/integrations] update failed:', err);
    return error.internal(c, 'Failed to update integration');
  }
});

app.delete('/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Integration', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/integrations] delete failed:', err);
    return error.internal(c, 'Failed to delete integration');
  }
});

export const integrationsRoutes = app;
