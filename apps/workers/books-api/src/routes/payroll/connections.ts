/**
 * Payroll provider connections: /api/payroll/connections (Gusto).
 *
 *   GET    /                list the entity's connections (never the token)
 *   POST   /                { provider: 'gusto', accessToken, companyId, environment?, accountMapping? }
 *   PUT    /:id/mapping     { accountMapping }  payroll category → account id
 *   POST   /:id/sync        { from?, to? }      import the processed payrolls not imported yet
 *   DELETE /:id             disconnect (the token is wiped; imported payrolls stay)
 *
 * The access token is supplied by the customer for now (no OAuth partner app
 * yet) and is checked against Gusto before it is stored, encrypted. The
 * Gusto client has only been tested against recorded fixtures.
 *
 * Permissions: journal:read | journal:create | journal:update | journal:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, list, cursorPagination, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import {
  createGustoConnection,
  disconnect,
  loadConnection,
  publicConnection,
  setAccountMapping,
  syncGustoConnection,
  type ConnectionRow,
} from '../../services/payroll/connections';
import { GustoApiError } from '../../services/payroll/gusto';
import { accountMappingSchema } from '../../services/payroll/mapping';
import { failPayroll } from './imports';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.payrollConnections;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const createSchema = z.object({
  provider: z.literal('gusto'),
  accessToken: z.string().trim().min(10).max(4000),
  companyId: z.string().trim().min(1).max(100),
  environment: z.enum(['production', 'demo']).default('production'),
  accountMapping: accountMappingSchema.optional(),
});
const mappingSchema = z.object({ accountMapping: accountMappingSchema });
const syncSchema = z.object({ from: day.optional(), to: day.optional() });

/** What events and audit see of a connection: no credentials, no mapping. */
function eventData(row: ConnectionRow) {
  return { id: row.id, entityId: row.entityId, provider: row.provider, providerCompanyId: row.providerCompanyId, status: row.status } as Record<string, unknown>;
}

function fail(c: Context, err: unknown, what: string) {
  if (err instanceof GustoApiError) {
    return err.status === 401 || err.status === 403 || err.status === 404 ? error.badRequest(c, err.message) : error.badGateway(c, err.message);
  }
  return failPayroll(c, err, what);
}

function requireKeyring(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const keyring = keyringFromEnv(c.env);
  return keyring.v1 || keyring.v2 ? keyring : null;
}

// GET /
app.get('/', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const keyring = keyringFromEnv(c.env);
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.entityId, entityId), isNull(t.deletedAt), ne(t.provider, 'csv')))
      .orderBy(desc(t.createdAt), desc(t.id));
    const data = await Promise.all(rows.map((row) => publicConnection(row, keyring)));
    return list(c, data, cursorPagination(data.length, false, null));
  } catch (err) {
    return fail(c, err, 'list payroll connections');
  }
});

// POST /
app.post('/', requirePermission('journal:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const keyring = requireKeyring(c);
    if (!keyring) return error.unavailable(c, 'No encryption key is configured, so credentials cannot be stored');
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const row = await createGustoConnection(db, {
      entityId,
      accessToken: data.accessToken,
      companyId: data.companyId,
      environment: data.environment,
      accountMapping: data.accountMapping,
      keyring,
    });
    await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'payroll_connection', entityId: row.id, action: 'created' });
    publishEntityEvent({ c, entityType: 'payroll_connection', entityId: row.id, action: 'created', data: eventData(row) });
    return success(c, await publicConnection(row, keyring), 201);
  } catch (err) {
    return fail(c, err, 'connect Gusto');
  }
});

// PUT /:id/mapping
app.put('/:id/mapping', requirePermission('journal:update'), zValidator('json', mappingSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const connection = await loadConnection(db, id);
    if (!connection || connection.provider === 'csv') return error.notFound(c, 'Payroll connection', id);
    const row = await setAccountMapping(db, connection, data.accountMapping);
    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'payroll_connection',
      entityId: id,
      action: 'updated',
      changes: { accountMapping: { old: connection.accountMapping, new: row.accountMapping } },
    });
    publishEntityEvent({ c, entityType: 'payroll_connection', entityId: id, action: 'updated', data: eventData(row) });
    return success(c, await publicConnection(row, keyringFromEnv(c.env)));
  } catch (err) {
    return fail(c, err, 'save the payroll account mapping');
  }
});

// POST /:id/sync
app.post('/:id/sync', requirePermission('journal:create'), zValidator('json', syncSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const keyring = requireKeyring(c);
    if (!keyring) return error.unavailable(c, 'No encryption key is configured, so credentials cannot be read');
    const connection = await loadConnection(db, id);
    if (!connection || connection.provider === 'csv') return error.notFound(c, 'Payroll connection', id);

    const result = await syncGustoConnection(db, {
      entityId: connection.entityId,
      connection,
      userId: c.get('userId') ?? null,
      keyring,
      from: data.from,
      to: data.to,
      today: new Date().toISOString().slice(0, 10),
    });
    for (const imported of result.imported) {
      await writeAccountingAudit(c, db, { accountingEntityId: connection.entityId, entityType: 'payroll_import', entityId: imported.importId, action: 'created' });
      publishEntityEvent({
        c,
        entityType: 'payroll_import',
        entityId: imported.importId,
        action: 'created',
        data: { id: imported.importId, entityId: connection.entityId, source: 'gusto', payDate: imported.payDate, status: 'posted', journalEntryId: imported.journalEntryId },
      });
    }
    return success(c, result);
  } catch (err) {
    return fail(c, err, 'sync Gusto payrolls');
  }
});

// DELETE /:id
app.delete('/:id', requirePermission('journal:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const connection = await loadConnection(db, id);
    if (!connection || connection.provider === 'csv') return error.notFound(c, 'Payroll connection', id);
    await disconnect(db, connection);
    await writeAccountingAudit(c, db, { accountingEntityId: connection.entityId, entityType: 'payroll_connection', entityId: id, action: 'deleted' });
    publishEntityEvent({ c, entityType: 'payroll_connection', entityId: id, action: 'deleted', data: eventData({ ...connection, status: 'disconnected' }) });
    return noContent(c);
  } catch (err) {
    return fail(c, err, 'disconnect the payroll connection');
  }
});

export const payrollConnectionsRoutes = app;
