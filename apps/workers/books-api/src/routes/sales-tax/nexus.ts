/**
 * /api/sales-tax/nexus: the economic nexus monitor (permission taxes:read).
 *
 *   GET /?asOf=          every state with a sales tax measured against its own rule
 *                        (sales, transactions, window, status below | approaching | exceeded, exceededOn, collectFrom,
 *                        registered); "register" opens an agency through /api/sales-tax-agencies
 *   GET /:state?asOf=    one state with the months of sales behind the measurement
 */

import { Hono, type Context } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { resolveEntityId } from '../../lib/entity-context';
import { TaxReturnError } from '../../services/sales-tax-returns/common';
import { loadUsEntity } from '../../services/sales-tax-returns/context';
import { nexusDetail, nexusOverview } from '../../services/nexus-monitor';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

function fail(c: Ctx, label: string, err: unknown): Response {
  if (err instanceof TaxReturnError) {
    if (err.kind === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    return error.badRequest(c, err.message, err.details);
  }
  console.error(`[books-api/nexus] ${label} failed:`, err);
  return error.internal(c, `Failed to ${label}`);
}

async function entityOf(c: Ctx) {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  if (!entityId) throw new TaxReturnError('No accounting entity resolved');
  return loadUsEntity(db, entityId);
}

function asOfOf(c: Ctx): string | undefined | Response {
  const asOf = c.req.query('asOf');
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return error.badRequest(c, 'asOf must be a YYYY-MM-DD date');
  return asOf;
}

app.get('/', requirePermission('taxes:read'), async (c) => {
  try {
    const asOf = asOfOf(c);
    if (asOf instanceof Response) return asOf;
    return success(c, await nexusOverview(c.get('tenantDb'), await entityOf(c), asOf));
  } catch (err) {
    return fail(c, 'fetch the nexus monitor', err);
  }
});

app.get('/:state', requirePermission('taxes:read'), async (c) => {
  try {
    const asOf = asOfOf(c);
    if (asOf instanceof Response) return asOf;
    const state = c.req.param('state') ?? '';
    const detail = await nexusDetail(c.get('tenantDb'), await entityOf(c), state, asOf);
    if (!detail) {
      return c.json({ error: { code: 'NOT_FOUND', message: `${state.toUpperCase()} has no sales tax to monitor` } }, 404);
    }
    return success(c, detail);
  } catch (err) {
    return fail(c, 'fetch the nexus detail', err);
  }
});

export const salesTaxNexusRoutes = app;
