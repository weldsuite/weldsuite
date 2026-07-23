/**
 * External webhook routes — customer-configured outbound webhook
 * subscriptions, flat `/api/external-webhooks/*` surface backed by
 * `external_webhooks` + `webhook_deliveries`.
 *
 * Distinct from `apps/workers/app-api/src/routes/workflow-webhooks` (inbound
 * WeldConnect trigger webhooks) — do not confuse the two.
 *
 * Permissions: webhooks:read | webhooks:create | webhooks:update | webhooks:delete.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { listAllEvents } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import {
  createExternalWebhook,
  getExternalWebhookById,
  getSubscribableEvents,
  listExternalWebhooks,
  listWebhookDeliveries,
  rotateExternalWebhookSecret,
  sendTestWebhook,
  softDeleteExternalWebhook,
  updateExternalWebhook,
} from '../../services/external-webhooks';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function isKnownEvent(value: string): boolean {
  return getSubscribableEvents().includes(value as never);
}

const headersSchema = z.record(z.string().max(500)).refine(
  (headers) => Object.keys(headers).length <= 20,
  { message: 'A webhook may define at most 20 custom headers' },
);

const createWebhookSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), { message: 'Webhook URL must use https://' }),
  events: z
    .array(z.string())
    .min(1, 'Select at least one event')
    .refine((events) => events.every(isKnownEvent), {
      message: 'One or more events are not in the entity-events catalog',
    }),
  headers: headersSchema.optional(),
});

const updateWebhookSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), { message: 'Webhook URL must use https://' })
    .optional(),
  events: z
    .array(z.string())
    .min(1, 'Select at least one event')
    .refine((events) => events.every(isKnownEvent), {
      message: 'One or more events are not in the entity-events catalog',
    })
    .optional(),
  headers: headersSchema.optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});

const deliveriesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

// GET /events — the full entity-events catalog, for the create/edit event picker.
app.get('/events', requirePermission('webhooks:read'), async (c) => {
  const events = listAllEvents().map((event) => {
    const dotIdx = event.indexOf('.');
    return {
      event,
      entity: event.slice(0, dotIdx),
      action: event.slice(dotIdx + 1),
    };
  });
  return success(c, events);
});

app.get('/', requirePermission('webhooks:read'), zValidator('query', listQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const result = await listExternalWebhooks(db, q);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/external-webhooks] list failed:', err);
    return error.internal(c, 'Failed to list webhooks');
  }
});

app.get('/:id', requirePermission('webhooks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const webhook = await getExternalWebhookById(db, id);
    if (!webhook) return error.notFound(c, 'Webhook', id);
    return success(c, webhook);
  } catch (err) {
    console.error('[app-api/external-webhooks] get failed:', err);
    return error.internal(c, 'Failed to fetch webhook');
  }
});

app.get('/:id/deliveries', requirePermission('webhooks:read'), zValidator('query', deliveriesQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const q = c.req.valid('query');
  try {
    const webhook = await getExternalWebhookById(db, id);
    if (!webhook) return error.notFound(c, 'Webhook', id);
    const result = await listWebhookDeliveries(db, id, q);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/external-webhooks] deliveries failed:', err);
    return error.internal(c, 'Failed to fetch webhook deliveries');
  }
});

app.post('/', requirePermission('webhooks:create'), zValidator('json', createWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('userId');
  try {
    const { webhook, secret } = await createExternalWebhook(db, { ...body, createdBy: userId });
    // The secret is only ever returned here and on rotate — never on GET.
    return success(c, { ...webhook, secret }, 201);
  } catch (err) {
    console.error('[app-api/external-webhooks] create failed:', err);
    return error.internal(c, 'Failed to create webhook');
  }
});

app.patch('/:id', requirePermission('webhooks:update'), zValidator('json', updateWebhookSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const webhook = await updateExternalWebhook(db, id, body);
    if (!webhook) return error.notFound(c, 'Webhook', id);
    return success(c, webhook);
  } catch (err) {
    console.error('[app-api/external-webhooks] update failed:', err);
    return error.internal(c, 'Failed to update webhook');
  }
});

app.post('/:id/rotate-secret', requirePermission('webhooks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await rotateExternalWebhookSecret(db, id);
    if (!result) return error.notFound(c, 'Webhook', id);
    return success(c, { ...result.webhook, secret: result.secret });
  } catch (err) {
    console.error('[app-api/external-webhooks] rotate-secret failed:', err);
    return error.internal(c, 'Failed to rotate webhook secret');
  }
});

app.post('/:id/test', requirePermission('webhooks:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const workspaceId = c.get('workspaceId') ?? '';
  try {
    const result = await sendTestWebhook(db, id, workspaceId);
    if (!result) return error.notFound(c, 'Webhook', id);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/external-webhooks] test failed:', err);
    return error.internal(c, 'Failed to send test webhook');
  }
});

app.delete('/:id', requirePermission('webhooks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const deleted = await softDeleteExternalWebhook(db, id);
    if (!deleted) return error.notFound(c, 'Webhook', id);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/external-webhooks] delete failed:', err);
    return error.internal(c, 'Failed to delete webhook');
  }
});

export const externalWebhooksRoutes = app;
