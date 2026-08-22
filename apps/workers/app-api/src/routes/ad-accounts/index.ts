/**
 * Ad account routes — /api/ad-accounts/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema, getWorkspaceForOrg } from '../../db';
import {
  decryptAccessToken,
  setAccountSelection,
  syncSelectedAccounts,
} from '../../services/ads/sync';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const accounts = schema.adAccounts;
const connections = schema.adPlatformConnections;

app.get('/', requirePermission('ad_accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const connectionId = c.req.query('connectionId');
  try {
    const rows = await db
      .select()
      .from(accounts)
      .where(
        and(
          isNull(accounts.deletedAt),
          ...(connectionId ? [eq(accounts.connectionId, connectionId)] : []),
        ),
      );
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/ad-accounts] list failed:', err);
    return error.internal(c, 'Failed to list ad accounts');
  }
});

const patchSchema = z.object({
  isSelected: z.boolean(),
});

app.patch('/:id', requirePermission('ad_accounts:update'), zValidator('json', patchSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const id = c.req.param('id');
  const { isSelected } = c.req.valid('json');

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
    .limit(1);
  if (!account) return error.notFound(c, 'Ad account', id);

  const [connection] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, account.connectionId), isNull(connections.deletedAt)))
    .limit(1);
  if (!connection) return error.notFound(c, 'Ad connection', account.connectionId);

  const accessToken = await decryptAccessToken(
    connection.oauthTokens?.accessToken,
    { v1: c.env.DATABASE_ENCRYPTION_KEY, v2: c.env.DATABASE_ENCRYPTION_KEY_V2 },
  );
  if (!accessToken) return error.badRequest(c, 'Connection has no valid access token');
  if (!orgId) return error.badRequest(c, 'No active workspace');

  const workspace = await getWorkspaceForOrg(c.env, orgId);
  const webhookBase = c.env.INTEGRATION_WEBHOOK_BASE_URL || 'https://integration-webhooks.weldsuite.org';

  try {
    await setAccountSelection(db, c.env, {
      accountId: id,
      isSelected,
      workspaceId: workspace.id,
      clerkOrgId: orgId,
      connectionId: account.connectionId,
      accessToken,
      webhookCallbackUrl: `${webhookBase.replace(/\/$/, '')}/webhooks/meta/ads`,
      webhookVerifyToken: c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'weldsuite-meta-ads',
    });

    if (isSelected) {
      await syncSelectedAccounts(db, c.env, account.connectionId, accessToken, workspace.id, orgId, {
        scope: 'full',
        platformAccountId: account.platformAccountId,
      });
    }

    const [updated] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/ad-accounts] patch failed:', err);
    return error.internal(c, 'Failed to update ad account');
  }
});

export const adAccountsRoutes = app;
