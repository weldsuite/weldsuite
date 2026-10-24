/**
 * Moneybird push — `/api/connectors/connections/:id/moneybird/*`.
 *
 * What the "Send sales to Moneybird" settings pick from (ledgers, accounts,
 * tax rates in the administration), how far the push is, and "Send now".
 * The settings themselves are saved through `PATCH /connections/:id`.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { ConnectorApiError } from '@weldsuite/connectors';
import { error, success } from '@weldsuite/worker-kit/response';
import { getConnectionById } from '@weldsuite/connect-domain/connectors/connections';
import {
  moneybirdPushOptions,
  moneybirdPushStatus,
  pushToMoneybird,
  scheduleMoneybirdPushBacklog,
} from '@weldsuite/connect-domain/connectors/moneybird-push';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function moneybirdConnection(c: { get: (key: 'tenantDb') => Variables['tenantDb'] }, id: string) {
  const row = await getConnectionById(c.get('tenantDb'), id);
  return row?.provider === 'moneybird' ? row : null;
}

app.get('/connections/:id/moneybird/options', requirePermission('integrations:read'), async (c) => {
  const row = await moneybirdConnection(c, c.req.param('id'));
  if (!row) return error.notFound(c, 'Moneybird connection', c.req.param('id'));
  try {
    return success(c, await moneybirdPushOptions(c.get('tenantDb'), c.env, row));
  } catch (err) {
    console.error('[connect-api/moneybird-push] options failed:', err);
    if (err instanceof ConnectorApiError && err.kind === 'auth') {
      return error.badRequest(c, 'Moneybird rejected the connection — reconnect it');
    }
    return error.badRequest(c, err instanceof Error ? err.message : 'Could not load Moneybird settings');
  }
});

app.get('/connections/:id/moneybird/push-status', requirePermission('integrations:read'), async (c) => {
  const row = await moneybirdConnection(c, c.req.param('id'));
  if (!row) return error.notFound(c, 'Moneybird connection', c.req.param('id'));
  return success(c, await moneybirdPushStatus(c.get('tenantDb'), row));
});

app.post('/connections/:id/moneybird/push', requirePermission('integrations:update'), async (c) => {
  const row = await moneybirdConnection(c, c.req.param('id'));
  if (!row) return error.notFound(c, 'Moneybird connection', c.req.param('id'));
  if (!row.settings?.moneybirdPush?.enabled) {
    return error.badRequest(c, 'Turn on sending to Moneybird first');
  }
  const db = c.get('tenantDb');
  // Send now retries failed invoices right away instead of after the cooldown.
  c.executionCtx.waitUntil(
    pushToMoneybird({ db, env: c.env, connection: row, trigger: 'manual', force: true })
      .then((result) => (result.remaining ? scheduleMoneybirdPushBacklog(c.env, row.id) : undefined))
      .catch((err) => console.error('[connect-api/moneybird-push] send now failed:', err)),
  );
  publishEntityEvent({
    c,
    entityType: 'connector_connection',
    action: 'sync_started',
    entityId: row.id,
    data: { id: row.id, provider: row.provider, syncs: ['moneybird-push'], full: false },
  });
  return success(c, { started: true });
});

export { app as moneybirdPushRoutes };
