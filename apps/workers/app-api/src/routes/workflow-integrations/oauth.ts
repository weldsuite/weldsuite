/**
 * OAuth + credential connect flow for WeldConnect integrations.
 *
 * Ports the proven generic OAuth pattern onto the `workflow_integrations`
 * table: a short-lived `state` is stashed in KV, the provider authorize URL is
 * built from the integration catalog, the callback exchanges the code, and the
 * (encrypted) tokens are persisted on a connected `workflow_integrations` row.
 *
 * A KV mapping `intconn:<id>` → { workspaceId, provider } and, for Slack,
 * `slack_team:<teamId>` → { workspaceId, integrationId } are written so the
 * inbound webhook worker can resolve the workspace from an event.
 *
 * Permissions: tasks:update.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { getIntegrationDef, type OAuthConfig } from '@weldsuite/workflow-integrations';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const wi = schema.workflowIntegrations;

const STATE_TTL_SECONDS = 600;

interface OAuthState {
  orgId: string;
  userId: string;
  provider: string;
  integrationId?: string;
}

/** Where the provider redirects back to — a single platform callback page that
 *  forwards `code`/`state` to POST /:provider/callback. Must be registered with
 *  each provider's OAuth app. */
function redirectUri(env: Env): string {
  const base = env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
  return `${base.replace(/\/$/, '')}/weldconnect/integrations/callback`;
}

async function enc(value: string | undefined, keyring: EncryptionKeyring): Promise<string | undefined> {
  if (!value) return undefined;
  return keyring.v1 || keyring.v2 ? encryptField(value, keyring) : value;
}

/** Begin an OAuth flow — returns the provider authorize URL the client opens. */
app.post(
  '/:provider/authorize',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ integrationId: z.string().optional() }).optional()),
  async (c) => {
    const provider = c.req.param('provider');
    const def = getIntegrationDef(provider);
    if (!def) return error.notFound(c, 'Integration', provider);
    if (def.auth.kind !== 'oauth2') {
      return error.badRequest(c, `Integration "${provider}" does not use OAuth`);
    }

    const auth = def.auth as OAuthConfig;
    const clientId = c.env[auth.clientIdEnv as keyof Env] as string | undefined;
    if (!clientId) return error.internal(c, `OAuth not configured for ${provider}`);

    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.badRequest(c, 'No active workspace');

    const body = c.req.valid('json');
    const state = crypto.randomUUID();
    const stateValue: OAuthState = { orgId, userId, provider, integrationId: body?.integrationId };
    await c.env.WORKSPACE_CACHE.put(`wf_oauth_state:${state}`, JSON.stringify(stateValue), {
      expirationTtl: STATE_TTL_SECONDS,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(c.env),
      response_type: 'code',
      state,
      ...(auth.authorizeParams ?? {}),
    });
    // Slack v2 uses `scope` for bot scopes; Google/others use space-delimited `scope`.
    params.set('scope', auth.scopes.join(' '));

    return success(c, { authorizeUrl: `${auth.authUrl}?${params.toString()}`, state });
  },
);

/** Finish an OAuth flow — exchange the code, encrypt + persist tokens. */
app.post(
  '/:provider/callback',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ code: z.string().min(1), state: z.string().min(1) })),
  async (c) => {
    const provider = c.req.param('provider');
    const def = getIntegrationDef(provider);
    if (!def || def.auth.kind !== 'oauth2') return error.notFound(c, 'Integration', provider);
    const auth = def.auth as OAuthConfig;

    const { code, state } = c.req.valid('json');
    const db = c.get('tenantDb');
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };

    // Validate state
    const stored = (await c.env.WORKSPACE_CACHE.get(`wf_oauth_state:${state}`, 'json')) as OAuthState | null;
    if (!stored || stored.provider !== provider || stored.orgId !== orgId) {
      return error.badRequest(c, 'Invalid or expired OAuth state');
    }
    await c.env.WORKSPACE_CACHE.delete(`wf_oauth_state:${state}`);

    const clientId = c.env[auth.clientIdEnv as keyof Env] as string | undefined;
    const clientSecret = c.env[auth.clientSecretEnv as keyof Env] as string | undefined;
    if (!clientId || !clientSecret) return error.internal(c, `OAuth not configured for ${provider}`);

    // Exchange code → tokens
    const tokenRes = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(c.env),
        grant_type: 'authorization_code',
      }),
    });
    const token = (await tokenRes.json()) as Record<string, any>;
    // Slack signals failure via `ok:false`; OAuth2 via http status / `error`.
    if (token.ok === false || token.error || !tokenRes.ok) {
      return error.badRequest(c, `Token exchange failed: ${token.error || tokenRes.status}`);
    }

    const accessToken: string | undefined = token.access_token;
    if (!accessToken) return error.badRequest(c, 'No access token in provider response');

    const expiresAt = token.expires_in
      ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
      : undefined;

    // Provider-specific fields stashed in settings (Slack team id for inbound).
    const settings: Record<string, unknown> = {};
    const teamId: string | undefined = token.team?.id;
    if (teamId) settings.teamId = teamId;
    if (token.bot_user_id) settings.botUserId = token.bot_user_id;

    const oauthTokens = {
      accessToken: (await enc(accessToken, encKey))!,
      refreshToken: await enc(token.refresh_token, encKey),
      expiresAt,
    };

    // Upsert the connection row (reconnect existing, else find by type, else create).
    let integrationId = stored.integrationId;
    if (!integrationId) {
      const [existing] = await db
        .select({ id: wi.id })
        .from(wi)
        .where(and(eq(wi.type, def.type), isNull(wi.deletedAt)))
        .limit(1);
      integrationId = existing?.id;
    }

    const now = new Date();
    const baseValues = {
      name: def.label,
      type: def.type,
      category: def.category,
      icon: def.icon,
      status: 'connected' as const,
      isOAuth: true,
      oauthProvider: provider,
      oauthScopes: auth.scopes,
      oauthTokens,
      settings: Object.keys(settings).length ? settings : undefined,
      connectedAt: now,
      connectedBy: userId,
      updatedAt: now,
    };

    if (integrationId) {
      await db.update(wi).set(baseValues).where(eq(wi.id, integrationId));
    } else {
      integrationId = generateId('int');
      await db.insert(wi).values({ id: integrationId, createdAt: now, ...baseValues });
    }

    // KV mappings for inbound webhook workspace resolution.
    await c.env.WORKSPACE_CACHE.put(
      `intconn:${integrationId}`,
      JSON.stringify({ workspaceId: orgId, provider }),
    );
    if (teamId) {
      await c.env.WORKSPACE_CACHE.put(
        `slack_team:${teamId}`,
        JSON.stringify({ workspaceId: orgId, integrationId }),
      );
    }

    return success(c, { id: integrationId, status: 'connected', provider });
  },
);

/** Connect an API-key based integration (no OAuth) by storing encrypted creds. */
app.post(
  '/:provider/apikey',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ credentials: z.record(z.string()) })),
  async (c) => {
    const provider = c.req.param('provider');
    const def = getIntegrationDef(provider);
    if (!def || def.auth.kind !== 'api_key') return error.notFound(c, 'Integration', provider);

    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const encKey = { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 };
    const { credentials } = c.req.valid('json');

    const encrypted: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) {
      encrypted[k] = encKey.v1 || encKey.v2 ? await encryptField(v, encKey) : v;
    }

    const now = new Date();
    const id = generateId('int');
    await db.insert(wi).values({
      id,
      createdAt: now,
      updatedAt: now,
      name: def.label,
      type: def.type,
      category: def.category,
      icon: def.icon,
      status: 'connected',
      credentials: encrypted,
      connectedAt: now,
      connectedBy: userId,
    });
    await c.env.WORKSPACE_CACHE.put(
      `intconn:${id}`,
      JSON.stringify({ workspaceId: c.get('orgId'), provider }),
    );
    return success(c, { id, status: 'connected', provider }, 201);
  },
);

export const workflowIntegrationOAuthRoutes = app;
