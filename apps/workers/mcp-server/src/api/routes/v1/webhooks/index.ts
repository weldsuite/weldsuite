import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { listAllEvents, publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

const createWebhookSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  workflowId: z.string().optional(),
  url: z.string().url(),
  isEnabled: z.boolean().optional(),
  allowedMethods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).optional(),
  headers: z.record(z.string()).optional(),
});

const updateWebhookSchema = createWebhookSchema.partial();

const listWebhooksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  workflowId: z.string().optional(),
  isEnabled: z.coerce.boolean().optional(),
});

const table = schema.workflowWebhooks;
const app = new Hono<HonoEnv>();

app.get('/events', requireScope('webhooks:read'), async (c) => {
  const events = listAllEvents().map((event) => {
    const dotIdx = event.indexOf('.');
    const entity = event.slice(0, dotIdx);
    const action = event.slice(dotIdx + 1);
    return { event, entity, action };
  });
  return success(c, events);
});

app.get('/', requireScope('webhooks:read'), zValidator('query', listWebhooksQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.workflowId) where.push(eq(table.workflowId, q.workflowId));
  if (q.isEnabled !== undefined) where.push(eq(table.isEnabled, q.isEnabled));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Webhook', id);
  return success(c, row);
});

app.post('/', requireScope('webhooks:write'), zValidator('json', createWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('wh');
  // workflowId is NOT NULL in the DB — use a placeholder if omitted so callers
  // can later link it via PATCH; alternatively enforce via schema if policy requires.
  const workflowId = body.workflowId ?? '';
  const [row] = await db
    .insert(table)
    .values({
      id,
      createdAt: now,
      updatedAt: now,
      workflowId,
      name: body.name,
      description: body.description,
      externalUrl: body.url,
      isEnabled: body.isEnabled ?? true,
      allowedMethods: body.allowedMethods,
      headers: body.headers,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create webhook');
  publishEntityEvent({ c, entityType: 'workflow_webhook', entityId: id, action: 'created', data: { id, workflowId } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('webhooks:write'), zValidator('json', updateWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.workflowId !== undefined) updates.workflowId = body.workflowId;
  if (body.url !== undefined) updates.externalUrl = body.url;
  if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled;
  if (body.allowedMethods !== undefined) updates.allowedMethods = body.allowedMethods;
  if (body.headers !== undefined) updates.headers = body.headers;
  const [row] = await db
    .update(table)
    .set(updates)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Webhook', id);
  publishEntityEvent({ c, entityType: 'workflow_webhook', entityId: id, action: 'updated', data: { id, workflowId: row.workflowId } });
  return success(c, row);
});

app.delete('/:id', requireScope('webhooks:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Webhook', id);
  publishEntityEvent({ c, entityType: 'workflow_webhook', entityId: id, action: 'deleted', data: { id, workflowId: row.workflowId } });
  return noContent(c);
});

export default app;
