/**
 * Payroll journal import: /api/payroll.
 *
 * Payroll itself stays in Gusto, ADP and the like; WeldBooks imports each
 * payroll's journal, one entry per payroll.
 *
 *   /imports        CSV import (summary or general-ledger shape), list, detail, reverse
 *   /connections    Gusto connection, account mapping, sync
 *   GET  /csv-mapping    the entity's saved CSV mapping, or null
 *   PUT  /csv-mapping    save one ({ shape, columns, accounts, dateFormat }); stored in the entity's
 *                        `csv` pseudo connection in payroll_connections
 *   GET  /categories     the payroll categories an account mapping can set
 *
 * Permissions: journal:read | create | update | delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { loadSavedCsvMapping, saveCsvMapping } from '../../services/payroll/connections';
import { PAYROLL_CATEGORIES, csvMappingSchema } from '../../services/payroll/mapping';
import { payrollConnectionsRoutes } from './connections';
import { failPayroll, payrollImportsRoutes } from './imports';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/imports', payrollImportsRoutes);
app.route('/connections', payrollConnectionsRoutes);

app.get('/categories', requirePermission('journal:read'), (c) =>
  success(
    c,
    Object.entries(PAYROLL_CATEGORIES).map(([key, label]) => ({
      key,
      label,
      side: ['employee_taxes', 'employee_deductions', 'payroll_liabilities', 'net_pay'].includes(key) ? 'credit' : 'debit',
      required: key === 'net_pay',
    })),
  ),
);

app.get('/csv-mapping', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return success(c, null);
    return success(c, await loadSavedCsvMapping(db, entityId));
  } catch (err) {
    return failPayroll(c, err, 'read the CSV mapping');
  }
});

app.put('/csv-mapping', requirePermission('journal:update'), zValidator('json', csvMappingSchema), async (c) => {
  const db = c.get('tenantDb');
  const mapping = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const { row, created } = await saveCsvMapping(db, entityId, mapping);
    await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'payroll_connection', entityId: row.id, action: created ? 'created' : 'updated' });
    publishEntityEvent({
      c,
      entityType: 'payroll_connection',
      entityId: row.id,
      action: created ? 'created' : 'updated',
      data: { id: row.id, entityId, provider: 'csv', status: row.status },
    });
    return success(c, mapping);
  } catch (err) {
    return failPayroll(c, err, 'save the CSV mapping');
  }
});

export const payrollRoutes = app;
export { payrollConnectionsRoutes, payrollImportsRoutes };
