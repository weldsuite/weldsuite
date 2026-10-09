/**
 * /api/sales-tax/reports: sales tax reports (permission taxes:read).
 *
 *   GET /liability?asOf=                          by agency and jurisdiction: collected, filed, paid, outstanding; ties to the ledger
 *   GET /sales-summary?from=&to=&groupBy=         gross, taxable, exempt (by reason), non-taxable and tax by customer | state | jurisdiction
 *   GET /exceptions?from=&to=                     documents with no ship-to, tax in an unregistered state, taxable sales without tax, ...
 *   GET /certificates/expiring?days=60            exemption certificates expiring (or lapsed in the last year)
 *   GET /certificates/missing?from=&to=           exempt sales with no certificate, with the 90-day cure deadline
 *   GET /provider-reconciliation?from=&to=&all=   provider engine (Stripe Tax, Avalara) against the tax ledger
 */

import { Hono, type Context } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { resolveEntityId } from '../../lib/entity-context';
import { TaxReturnError, addMonthsIso, todayIn } from '../../services/sales-tax-returns/common';
import { loadUsEntity } from '../../services/sales-tax-returns/context';
import {
  exceptionsReport,
  expiringCertificates,
  liabilityReport,
  missingCertificates,
  providerReconciliation,
  salesSummary,
  type SalesSummaryGroup,
} from '../../services/sales-tax-reports';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(c: Ctx, label: string, err: unknown): Response {
  if (err instanceof TaxReturnError) {
    if (err.kind === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    return error.badRequest(c, err.message, err.details);
  }
  console.error(`[books-api/sales-tax-reports] ${label} failed:`, err);
  return error.internal(c, `Failed to ${label}`);
}

async function entityOf(c: Ctx) {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  if (!entityId) throw new TaxReturnError('No accounting entity resolved');
  return loadUsEntity(db, entityId);
}

/** `from` and `to` of a request: given, or the year to date. */
function range(c: Ctx, timeZone: string | null): { from: string; to: string } | Response {
  const today = todayIn(timeZone);
  const from = c.req.query('from') ?? `${today.slice(0, 4)}-01-01`;
  const to = c.req.query('to') ?? today;
  if (!DAY.test(from) || !DAY.test(to)) return error.badRequest(c, 'from and to must be YYYY-MM-DD dates');
  if (to < from) return error.badRequest(c, 'to must not be before from');
  return { from, to };
}

app.get('/liability', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const asOf = c.req.query('asOf') ?? todayIn(entity.timezone);
    if (!DAY.test(asOf)) return error.badRequest(c, 'asOf must be a YYYY-MM-DD date');
    return success(c, await liabilityReport(c.get('tenantDb'), entity, asOf));
  } catch (err) {
    return fail(c, 'fetch the sales tax liability', err);
  }
});

app.get('/sales-summary', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const groupBy = (c.req.query('groupBy') ?? 'state') as SalesSummaryGroup;
    if (!['customer', 'state', 'jurisdiction'].includes(groupBy)) {
      return error.badRequest(c, 'groupBy must be customer, state or jurisdiction');
    }
    const window = range(c, entity.timezone);
    if (window instanceof Response) return window;
    return success(c, await salesSummary(c.get('tenantDb'), entity.id, { ...window, groupBy }));
  } catch (err) {
    return fail(c, 'fetch the sales summary', err);
  }
});

app.get('/exceptions', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const window = range(c, entity.timezone);
    if (window instanceof Response) return window;
    return success(c, await exceptionsReport(c.get('tenantDb'), entity.id, window));
  } catch (err) {
    return fail(c, 'fetch the sales tax exceptions', err);
  }
});

app.get('/certificates/expiring', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const days = Math.min(Math.max(Number.parseInt(c.req.query('days') ?? '60', 10) || 60, 1), 730);
    return success(c, await expiringCertificates(c.get('tenantDb'), entity, { days }));
  } catch (err) {
    return fail(c, 'fetch expiring certificates', err);
  }
});

app.get('/certificates/missing', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) {
      return error.badRequest(c, 'from and to must be YYYY-MM-DD dates');
    }
    return success(c, await missingCertificates(c.get('tenantDb'), entity, { from, to }));
  } catch (err) {
    return fail(c, 'fetch missing certificates', err);
  }
});

app.get('/provider-reconciliation', requirePermission('taxes:read'), async (c) => {
  try {
    const entity = await entityOf(c);
    const today = todayIn(entity.timezone);
    const from = c.req.query('from') ?? addMonthsIso(today, -1);
    const to = c.req.query('to') ?? today;
    if (!DAY.test(from) || !DAY.test(to)) return error.badRequest(c, 'from and to must be YYYY-MM-DD dates');
    const all = c.req.query('all') === '1' || c.req.query('all') === 'true';
    return success(c, await providerReconciliation(c.get('tenantDb'), entity, { from, to, all }));
  } catch (err) {
    return fail(c, 'reconcile the tax provider', err);
  }
});

export const salesTaxReportsRoutes = app;
