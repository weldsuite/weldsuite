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
import { listAllEvents, listCustomObjectEvents } from '@weldsuite/entity-events';
import { listCustomObjects } from '../../services/custom-objects';
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

/**
 * Static catalog check, plus a SHAPE check for WeldObjects events.
 *
 * `co_<slug>.<action>` names can't be validated here — this schema is built at
 * module scope with no tenant DB — but rejecting them outright meant
 * `GET /events` offered custom object events that `POST /` then refused. The
 * authoritative existence check happens in the handlers below, where the
 * tenant's objects are actually loadable.
 */
function isKnownEvent(value: string): boolean {
  if (getSubscribableEvents().includes(value as never)) return true;
  return CUSTOM_OBJECT_EVENT_PATTERN.test(value);
}

const CUSTOM_OBJECT_EVENT_PATTERN = /^co_[a-z][a-z0-9_]{0,23}\.(created|updated|deleted)$/;

/**
 * Reject subscriptions to custom object events whose object doesn't exist (or
 * has events switched off) — otherwise a typo produces a webhook that silently
 * never fires. Returns the offending event names.
 */
async function unknownCustomObjectEvents(
  db: Parameters<typeof listCustomObjects>[0],
  events: string[],
): Promise<string[]> {
  const custom = events.filter((e) => CUSTOM_OBJECT_EVENT_PATTERN.test(e));
  if (custom.length === 0) return [];

  const objects = await listCustomObjects(db);
  const enabled = new Set(
    objects.filter((o) => o.enableEvents).map((o) => o.entityKey),
  );
  return custom.filter((e) => !enabled.has(e.slice(0, e.indexOf('.'))));
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
  const toEntry = (event: string, label?: string) => {
    const dotIdx = event.indexOf('.');
    return {
      event,
      entity: event.slice(0, dotIdx),
      action: event.slice(dotIdx + 1),
      ...(label ? { label } : {}),
    };
  };

  const events = listAllEvents().map((e) => toEntry(e));

  // WeldObjects events (`co_<slug>.created` …) exist only at runtime, so they
  // are appended from the tenant's own object rows. Only objects with events
  // enabled are offered — subscribing to an object that never publishes would
  // produce a webhook that silently never fires.
  try {
    const db = c.get('tenantDb');
    const objects = await listCustomObjects(db);
    for (const object of objects) {
      if (!object.enableEvents) continue;
      for (const event of listCustomObjectEvents(object.slug)) {
        events.push(toEntry(event, object.labelPlural));
      }
    }
  } catch (err) {
    console.error('[app-api/external-webhooks] custom object event merge failed:', err);
  }

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
    const unknown = await unknownCustomObjectEvents(db, body.events);
    if (unknown.length > 0) {
      return error.badRequest(
        c,
        `Unknown custom object event(s): ${unknown.join(', ')}. The object may not exist, or may have workflow events switched off.`,
      );
    }

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
    if (body.events) {
      const unknown = await unknownCustomObjectEvents(db, body.events);
      if (unknown.length > 0) {
        return error.badRequest(
          c,
          `Unknown custom object event(s): ${unknown.join(', ')}. The object may not exist, or may have workflow events switched off.`,
        );
      }
    }

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
