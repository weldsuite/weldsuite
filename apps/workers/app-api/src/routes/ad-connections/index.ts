/**
 * Ad platform connection routes — /api/ad-connections/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  exchangeForLongLivedToken,
  getMetaUserProfile,
} from '@weldsuite/meta-ads';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, getWorkspaceForOrg } from '../../db';
import {
  adsOAuthRedirectUri,
  consumeAdsOAuthState,
  facebookCredentials,
  storeAdsOAuthState,
} from '../../services/ads/meta-oauth';
import {
  cleanupConnectionMappings,
  decryptAccessToken,
  discoverAdAccounts,
  encryptOAuthTokens,
  stripConnectionSecrets,
  syncSelectedAccounts,
} from '../../services/ads/sync';
import { deleteAdSyncIndex, upsertAdSyncIndex } from '../../services/ads/sync-index';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const connections = schema.adPlatformConnections;

function encryptionKeyring(env: Env) {
  return { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
}

app.get('/', requirePermission('ad_accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db
      .select()
      .from(connections)
      .where(isNull(connections.deletedAt))
      .orderBy(desc(connections.createdAt));
    return success(c, rows.map(stripConnectionSecrets));
  } catch (err) {
    console.error('[app-api/ad-connections] list failed:', err);
    return error.internal(c, 'Failed to list ad connections');
  }
});

app.post('/facebook/authorize', requirePermission('ad_accounts:update'), async (c) => {
  const { appId } = facebookCredentials(c.env);
  if (!appId) return error.internal(c, 'Facebook OAuth is not configured');

  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) return error.badRequest(c, 'No active workspace');

  const state = crypto.randomUUID();
  await storeAdsOAuthState(c.env.WORKSPACE_CACHE, state, { orgId, userId, platform: 'facebook' });

  const authorizeUrl = buildAuthorizeUrl({
    appId,
    redirectUri: adsOAuthRedirectUri(c.env),
    state,
  });
  return success(c, { authorizeUrl, state });
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

app.post('/facebook/callback', requirePermission('ad_accounts:update'), zValidator('json', callbackSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.badRequest(c, 'No active workspace');

  const { code, state } = c.req.valid('json');
  const oauthState = await consumeAdsOAuthState(c.env.WORKSPACE_CACHE, state, orgId);
  if (!oauthState) return error.badRequest(c, 'Invalid or expired OAuth state');

  const { appId, appSecret } = facebookCredentials(c.env);
  if (!appId || !appSecret) return error.internal(c, 'Facebook OAuth is not configured');

  const redirectUri = adsOAuthRedirectUri(c.env);
  const db = c.get('tenantDb');
  const keyring = encryptionKeyring(c.env);

  try {
    const shortLived = await exchangeCodeForTokens({ appId, appSecret, redirectUri, code });
    const longLived = await exchangeForLongLivedToken({
      appId,
      appSecret,
      shortLivedToken: shortLived.accessToken,
    });
    const profile = await getMetaUserProfile(longLived.accessToken);
    const workspace = await getWorkspaceForOrg(c.env, orgId);
    const now = new Date();

    const [existing] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.platform, 'facebook'), isNull(connections.deletedAt)))
      .limit(1);

    const connectionId = existing?.id ?? generateId('adcn');
    const values = {
      platform: 'facebook' as const,
      status: 'active' as const,
      metaUserId: profile.id,
      metaUserName: profile.name,
      oauthTokens: await encryptOAuthTokens(longLived.accessToken, keyring),
      tokenExpiresAt: longLived.expiresAt ? new Date(longLived.expiresAt) : null,
      lastError: null,
      updatedAt: now,
    };

    if (existing) {
      await db.update(connections).set(values).where(eq(connections.id, existing.id));
    } else {
      await db.insert(connections).values({
        id: connectionId,
        createdAt: now,
        ...values,
      });
    }

    await discoverAdAccounts(db, c.env, connectionId, longLived.accessToken);

    await upsertAdSyncIndex(c.env, {
      workspaceId: workspace.id,
      connectionId,
      clerkOrgId: orgId,
      isEnabled: false,
    });

    publishEntityEvent({
      c,
      entityType: 'ad_platform_connection',
      action: existing ? 'updated' : 'created',
      entityId: connectionId,
      data: { id: connectionId, platform: 'facebook', status: 'active' },
    });

    return success(c, { id: connectionId, platform: 'facebook', status: 'active' });
  } catch (err) {
    console.error('[app-api/ad-connections] facebook callback failed:', err);
    return error.badRequest(c, err instanceof Error ? err.message : 'Facebook OAuth failed');
  }
});

app.post('/:id/sync', requirePermission('ad_accounts:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const id = c.req.param('id');
  const scope = c.req.query('scope');
  const syncScope =
    scope === 'push'
      ? 'push'
      : scope === 'pull' || scope === 'metrics'
        ? 'pull'
        : 'full';

  const [connection] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  if (!connection) return error.notFound(c, 'Ad connection', id);

  const accessToken = await decryptAccessToken(connection.oauthTokens?.accessToken, encryptionKeyring(c.env));
  if (!accessToken) return error.badRequest(c, 'Connection has no valid access token');

  try {
    const workspace = orgId ? await getWorkspaceForOrg(c.env, orgId) : null;
    const result = await syncSelectedAccounts(
      db,
      c.env,
      id,
      accessToken,
      workspace?.id ?? '',
      orgId ?? '',
      {
        scope: syncScope,
        platformAccountId: c.req.query('platformAccountId') || undefined,
        platformCampaignId: c.req.query('platformCampaignId') || undefined,
      },
    );
    return success(c, result);
  } catch (err) {
    console.error('[app-api/ad-connections] sync failed:', err);
    await db
      .update(connections)
      .set({ status: 'error', lastError: err instanceof Error ? err.message : 'Sync failed', updatedAt: new Date() })
      .where(eq(connections.id, id));
    return error.internal(c, 'Failed to sync ad connection');
  }
});

app.delete('/:id', requirePermission('ad_accounts:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const id = c.req.param('id');

  const [connection] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  if (!connection) return error.notFound(c, 'Ad connection', id);

  const now = new Date();
  await cleanupConnectionMappings(db, c.env, id);
  await db
    .update(connections)
    .set({ deletedAt: now, updatedAt: now, status: 'error' })
    .where(eq(connections.id, id));

  if (orgId) {
    const workspace = await getWorkspaceForOrg(c.env, orgId);
    await deleteAdSyncIndex(c.env, workspace.id, id);
  }

  publishEntityEvent({
    c,
    entityType: 'ad_platform_connection',
    action: 'deleted',
    entityId: id,
    data: { id, platform: connection.platform },
  });

  return noContent(c);
});

export const adConnectionsRoutes = app;
