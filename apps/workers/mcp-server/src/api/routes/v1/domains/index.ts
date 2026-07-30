import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createDomainSchema,
  updateDomainSchema,
  listDomainsQuery,
} from '@weldsuite/core-api-client/schemas/domains';
import {
  createDnsZoneSchema,
  updateDnsZoneSchema,
} from '@weldsuite/core-api-client/schemas/dns-zones';
import {
  createDnsRecordSchema,
  updateDnsRecordSchema,
} from '@weldsuite/core-api-client/schemas/dns-records';

const domainTable = schema.hostDomains;
const zoneTable = schema.hostDnsZones;
const recordTable = schema.hostDnsRecords;

const DOMAIN_DATE_FIELDS = ['registrarSyncedAt', 'registeredAt', 'expiresAt', 'renewedAt', 'authCodeExpiresAt'] as const;

function coerceDates(data: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out = { ...data };
  for (const f of fields) if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  return out;
}

const app = new Hono<HonoEnv>();

// ---- Domains ----------------------------------------------------------------

app.get('/', requireScope('domains:read'), zValidator('query', listDomainsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(domainTable.fullDomain, term), like(domainTable.name, term)));
  }
  if (q.status && q.status !== 'all') where.push(eq(domainTable.status, q.status as Exclude<typeof q.status, 'all'>));
  const result = await listWithCursor({ db, table: domainTable, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('domains:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(domainTable)
    .where(and(eq(domainTable.id, id), isNull(domainTable.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Domain', id);
  return success(c, row);
});

app.post('/', requireScope('domains:write'), zValidator('json', createDomainSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('dom');
  const [row] = await db
    .insert(domainTable)
    .values({ id, createdAt: now, updatedAt: now, ...coerceDates(body as Record<string, unknown>, DOMAIN_DATE_FIELDS) } as typeof domainTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create domain');
  publishEntityEvent({ c, entityType: 'domain', entityId: id, action: 'created', data: { id, name: row.fullDomain, status: row.status } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('domains:write'), zValidator('json', updateDomainSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(domainTable)
    .set({ ...coerceDates(body as Record<string, unknown>, DOMAIN_DATE_FIELDS), updatedAt: new Date() })
    .where(and(eq(domainTable.id, id), isNull(domainTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Domain', id);
  publishEntityEvent({ c, entityType: 'domain', entityId: id, action: 'updated', data: { id, name: row.fullDomain, status: row.status } });
  return success(c, row);
});

app.delete('/:id', requireScope('domains:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(domainTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(domainTable.id, id), isNull(domainTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Domain', id);
  publishEntityEvent({ c, entityType: 'domain', entityId: id, action: 'deleted', data: { id, name: row.fullDomain, status: row.status } });
  return noContent(c);
});

// ---- Nested: /:domainId/zones -----------------------------------------------

const zonesApp = new Hono<HonoEnv>();

zonesApp.get('/', requireScope('domains:read'), async (c) => {
  const db = c.get('tenantDb');
  const domainId = c.req.param('domainId') as string;
  const result = await listWithCursor({ db, table: zoneTable, where: [eq(zoneTable.domainId, domainId)] });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

zonesApp.get('/:id', requireScope('domains:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(zoneTable)
    .where(and(eq(zoneTable.id, id), isNull(zoneTable.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'DnsZone', id);
  return success(c, row);
});

zonesApp.post('/', requireScope('domains:write'), zValidator('json', createDnsZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const domainId = c.req.param('domainId') as string;
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('zone');
  const [row] = await db
    .insert(zoneTable)
    .values({ id, createdAt: now, updatedAt: now, domainId, ...(body as Record<string, unknown>) } as typeof zoneTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create DNS zone');
  publishEntityEvent({ c, entityType: 'dns_zone', entityId: id, action: 'created', data: { id, name: row.name, status: row.status } });
  return success(c, row, 201);
});

zonesApp.patch('/:id', requireScope('domains:write'), zValidator('json', updateDnsZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(zoneTable)
    .set({ ...coerceDates(body as Record<string, unknown>, ['syncedAt']), updatedAt: new Date() })
    .where(and(eq(zoneTable.id, id), isNull(zoneTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'DnsZone', id);
  publishEntityEvent({ c, entityType: 'dns_zone', entityId: id, action: 'updated', data: { id, name: row.name, status: row.status } });
  return success(c, row);
});

zonesApp.delete('/:id', requireScope('domains:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(zoneTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(zoneTable.id, id), isNull(zoneTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'DnsZone', id);
  publishEntityEvent({ c, entityType: 'dns_zone', entityId: id, action: 'deleted', data: { id, name: row.name, status: row.status } });
  return noContent(c);
});

// ---- Nested: /:domainId/zones/:zoneId/records --------------------------------
// NOTE: external-api keeps DNS records LOCAL-ONLY — it does not proxy the
// Cloudflare API (unlike app-api). Records here will not propagate to Cloudflare.

const recordsApp = new Hono<HonoEnv>();

recordsApp.get('/', requireScope('domains:read'), async (c) => {
  const db = c.get('tenantDb');
  const zoneId = c.req.param('zoneId') as string;
  const result = await listWithCursor({
    db,
    table: recordTable,
    where: [eq(recordTable.zoneId, zoneId)],
    softDelete: false,
  });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

recordsApp.get('/:id', requireScope('domains:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(recordTable)
    .where(eq(recordTable.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'DnsRecord', id);
  return success(c, row);
});

recordsApp.post('/', requireScope('domains:write'), zValidator('json', createDnsRecordSchema), async (c) => {
  const db = c.get('tenantDb');
  const zoneId = c.req.param('zoneId') as string;
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('rec');
  const [row] = await db
    .insert(recordTable)
    .values({ id, createdAt: now, updatedAt: now, zoneId, ...(body as Record<string, unknown>) } as typeof recordTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create DNS record');
  publishEntityEvent({
    c,
    entityType: 'dns_record',
    entityId: id,
    action: 'created',
    data: { id, zoneId, name: row.name, type: row.type, value: row.value },
  });
  return success(c, row, 201);
});

recordsApp.patch('/:id', requireScope('domains:write'), zValidator('json', updateDnsRecordSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(recordTable)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(recordTable.id, id))
    .returning();
  if (!row) return error.notFound(c, 'DnsRecord', id);
  publishEntityEvent({
    c,
    entityType: 'dns_record',
    entityId: id,
    action: 'updated',
    data: { id, zoneId: row.zoneId, name: row.name, type: row.type, value: row.value },
  });
  return success(c, row);
});

recordsApp.delete('/:id', requireScope('domains:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // hostDnsRecords has no deletedAt — hard delete
  const [row] = await db
    .delete(recordTable)
    .where(eq(recordTable.id, id))
    .returning();
  if (!row) return error.notFound(c, 'DnsRecord', id);
  publishEntityEvent({ c, entityType: 'dns_record', entityId: id, action: 'deleted', data: { id, zoneId: row.zoneId } });
  return noContent(c);
});

zonesApp.route('/:zoneId/records', recordsApp);
app.route('/:domainId/zones', zonesApp);

export default app;
