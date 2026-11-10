/**
 * WeldDesk service catalogue — /api/desk/catalog
 *
 * Request items, each with its own form (a customer ticket type), approval
 * steps and fulfilment tasks. Written by `@weldsuite/db/lib/desk-catalog`.
 * The request side (making a conversation a request, deciding its approvals)
 * is on the conversation: ../desk-conversations/request.
 *
 *   GET    /                list the items          (conversations:read; ?all=1 adds switched-off ones, settings:read)
 *   GET    /approvals       pending approvals       (conversations:read; ?scope=mine (default) | all, all needs settings:update)
 *   GET    /:id             one item                (conversations:read)
 *   POST   /                create an item          (settings:update)   201
 *   PATCH  /:id             change an item          (settings:update)
 *   DELETE /:id             delete an item          (settings:update)   204
 *
 * Every mutation publishes a `desk_catalog_item` entity event. Answers: 400
 * `details.field` for an item that can't be saved, 404 for an unknown item.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskCatalogItemSchema,
  deskCatalogApprovalsQuerySchema,
  deskCatalogListQuerySchema,
  updateDeskCatalogItemSchema,
} from '@weldsuite/core-api-client/schemas/desk-catalog';
import {
  createDeskCatalogItem,
  DeskCatalogRejectedError,
  deleteDeskCatalogItem,
  getDeskCatalogItem,
  listDeskCatalogItems,
  listDeskPendingApprovals,
  updateDeskCatalogItem,
} from '@weldsuite/db/lib/desk-catalog';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_APPROVALS_LIMIT = 100;

function refusal(c: Ctx, err: unknown, failure: string) {
  if (err instanceof DeskCatalogRejectedError) return error.badRequest(c, err.message, { field: err.field });
  console.error(`[desk-api/desk-catalog] ${failure}:`, err);
  return error.internal(c, failure);
}

app.get('/', requirePermission('conversations:read'), zValidator('query', deskCatalogListQuerySchema), async (c) => {
  const { all } = c.req.valid('query');
  try {
    if (all && !(await hasContextPermission(c, 'settings:read'))) {
      return error.forbidden(c, 'Reading the whole catalogue needs settings access');
    }
    return success(c, await listDeskCatalogItems(c.get('tenantDb'), { activeOnly: !all }));
  } catch (err) {
    return refusal(c, err, 'Failed to load the service catalogue');
  }
});

// Before /:id, which would take "approvals" for an id.
app.get('/approvals', requirePermission('conversations:read'), zValidator('query', deskCatalogApprovalsQuerySchema), async (c) => {
  const { scope = 'mine', limit = DEFAULT_APPROVALS_LIMIT } = c.req.valid('query');
  try {
    if (scope === 'all' && !(await hasContextPermission(c, 'settings:update'))) {
      return error.forbidden(c, 'Seeing every approval needs settings access');
    }
    return success(
      c,
      await listDeskPendingApprovals(c.get('tenantDb'), {
        approverId: scope === 'all' ? undefined : c.get('userId'),
        limit,
      }),
    );
  } catch (err) {
    return refusal(c, err, 'Failed to load the approvals');
  }
});

app.get('/:id', requirePermission('conversations:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const item = await getDeskCatalogItem(c.get('tenantDb'), id);
    if (!item) return error.notFound(c, 'Catalogue item', id);
    return success(c, item);
  } catch (err) {
    return refusal(c, err, 'Failed to load the catalogue item');
  }
});

app.post('/', requirePermission('settings:update'), zValidator('json', createDeskCatalogItemSchema), async (c) => {
  const data = c.req.valid('json');
  try {
    const item = await createDeskCatalogItem(c.get('tenantDb'), { ...data, generateId, createdById: c.get('userId') });
    publishEntityEvent({
      c,
      entityType: 'desk_catalog_item',
      action: 'created',
      entityId: item.id,
      data: item as unknown as Record<string, unknown>,
    });
    return success(c, item, 201);
  } catch (err) {
    return refusal(c, err, 'Failed to create the catalogue item');
  }
});

app.patch('/:id', requirePermission('settings:update'), zValidator('json', updateDeskCatalogItemSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const item = await updateDeskCatalogItem(c.get('tenantDb'), id, { ...data, generateId });
    if (!item) return error.notFound(c, 'Catalogue item', id);
    publishEntityEvent({
      c,
      entityType: 'desk_catalog_item',
      action: 'updated',
      entityId: item.id,
      data: item as unknown as Record<string, unknown>,
    });
    return success(c, item);
  } catch (err) {
    return refusal(c, err, 'Failed to update the catalogue item');
  }
});

app.delete('/:id', requirePermission('settings:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const item = await deleteDeskCatalogItem(c.get('tenantDb'), id);
    if (!item) return error.notFound(c, 'Catalogue item', id);
    publishEntityEvent({
      c,
      entityType: 'desk_catalog_item',
      action: 'deleted',
      entityId: item.id,
      data: item as unknown as Record<string, unknown>,
    });
    return noContent(c);
  } catch (err) {
    return refusal(c, err, 'Failed to delete the catalogue item');
  }
});

export { app as deskCatalogRoutes };
