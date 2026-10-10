import { Hono, type Context } from 'hono';
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
  createOpportunitySchema,
  updateOpportunitySchema,
  listOpportunitiesQuery,
} from '@weldsuite/core-api-client/schemas/opportunities';
import { asText } from '@weldsuite/text';

const table = schema.crmOpportunities;
const app = new Hono<HonoEnv>();

/** Numeric (decimal) columns Drizzle expects as strings. */
const NUMERIC_FIELDS = new Set(['amount', 'expectedRevenue', 'recurringRevenue']);
/** Timestamp columns that arrive as ISO strings. */
const DATE_FIELDS = new Set(['closeDate', 'startDate', 'nextStepDate']);

/** Coerce one PATCH field to the shape its column expects. */
function coerceUpdateValue(key: string, value: unknown): unknown {
  if (NUMERIC_FIELDS.has(key)) return value == null ? value : asText(value);
  if (DATE_FIELDS.has(key) && typeof value === 'string') return value === '' ? null : new Date(value);
  return value;
}

/** Build the Drizzle `set` payload from a PATCH body, skipping undefined fields. */
function buildUpdatePayload(body: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    update[k] = coerceUpdateValue(k, v);
  }
  return update;
}

type OpportunityRow = typeof table.$inferSelect;

/** Publish `updated` plus any `stage_changed` / `won` / `lost` transition events. */
function publishUpdateEvents(c: Context<HonoEnv>, id: string, existing: OpportunityRow, row: OpportunityRow): void {
  const eventData = {
    id,
    name: row.name,
    amount: row.amount ?? '0',
    currency: row.currency,
    stage: row.stage,
    status: row.status,
    customerId: row.customerId,
    ownerId: row.ownerId,
  };
  publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: 'updated', data: eventData });
  if (row.stage !== existing.stage) {
    publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: 'stage_changed', data: eventData });
  }
  if (row.status === existing.status) return;
  if (row.status === 'won') {
    publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: 'won', data: eventData });
  }
  if (row.status === 'lost') {
    publishEntityEvent({ c, entityType: 'opportunity', entityId: id, action: 'lost', data: eventData });
  }
}

app.get('/', requireScope('opportunities:read'), zValidator('query', listOpportunitiesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.name, term), like(table.customerName, term)));
  }
  if (q.status) where.push(eq(table.status, q.status));
  if (q.stage) where.push(eq(table.stage, q.stage));
  if (q.pipeline) where.push(eq(table.pipeline, q.pipeline));
  if (q.ownerId) where.push(eq(table.ownerId, q.ownerId));
  if (q.customerId) where.push(eq(table.customerId, q.customerId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('opportunities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Opportunity', id);
  return success(c, row);
});

app.post('/', requireScope('opportunities:write'), zValidator('json', createOpportunitySchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const ownerId = (body.ownerId as string | undefined) ?? c.get('apiSession').userId;
  if (!ownerId) return error.badRequest(c, 'ownerId is required for workspace API keys');
  const now = new Date();
  const id = generateId('opp');
  const values: Record<string, unknown> = { ...body, id, ownerId, createdAt: now, updatedAt: now };
  // Coerce numeric + date columns and apply defaults.
  for (const f of NUMERIC_FIELDS) if (values[f] != null) values[f] = asText(values[f]);
  for (const f of DATE_FIELDS) if (typeof values[f] === 'string') values[f] = new Date(values[f] as string);
  values.amount = values.amount != null ? asText(values.amount) : '0';
  values.currency = values.currency ?? 'EUR';
  values.stage = values.stage ?? 'prospecting';
  values.status = values.status ?? 'open';
  values.probability = values.probability ?? 0;
  values.pipeline = values.pipeline ?? 'default';
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create opportunity');
  publishEntityEvent({
    c,
    entityType: 'opportunity',
    entityId: id,
    action: 'created',
    data: {
      id,
      name: row.name,
      amount: row.amount ?? '0',
      currency: row.currency,
      stage: row.stage,
      status: row.status,
      customerId: row.customerId,
      pipelineId: row.pipeline,
      ownerId: row.ownerId,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('opportunities:write'), zValidator('json', updateOpportunitySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Opportunity', id);
  const update = buildUpdatePayload(body as Record<string, unknown>);
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update opportunity');
  publishUpdateEvents(c, id, existing, row);
  return success(c, row);
});

app.delete('/:id', requireScope('opportunities:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Opportunity', id);
  publishEntityEvent({
    c,
    entityType: 'opportunity',
    entityId: id,
    action: 'deleted',
    data: {
      id,
      name: row.name,
      amount: row.amount ?? '0',
      stage: row.stage,
      status: row.status,
      customerId: row.customerId,
    },
  });
  return noContent(c);
});

export default app;
