/**
 * Ad account routes — /api/ad-accounts/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema, getWorkspaceForOrg } from '../../db';
import {
  setAccountSelection,
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
  if (!orgId) return error.badRequest(c, 'No active workspace');

  const workspace = await getWorkspaceForOrg(c.env, orgId);

  try {
    await setAccountSelection(db, c.env, {
      accountId: id,
      isSelected,
      workspaceId: workspace.id,
      clerkOrgId: orgId,
      connectionId: account.connectionId,
    });

    const [updated] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'ad_account',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/ad-accounts] patch failed:', err);
    return error.internal(c, 'Failed to update ad account');
  }
});

export const adAccountsRoutes = app;
