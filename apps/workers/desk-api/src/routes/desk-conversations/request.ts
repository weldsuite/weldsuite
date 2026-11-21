/**
 * WeldDesk service requests on a conversation —
 * /api/desk/conversations/:id/{request,catalog-item,approval,fulfilment}
 *
 * A conversation is a service request when it was made from a catalogue item
 * (`catalog_item_id`): the item's form is its ticket type, its approval steps
 * are decided in order, and once approved (or at once, without steps) its
 * fulfilment tasks become WeldFlow tasks linked to the conversation.
 *
 *   GET  /:id/request       the item, approval state and steps   (conversations:read; null when not a request)
 *   PUT  /:id/catalog-item  make it a request of an item         (conversations:update)
 *   POST /:id/approval      decide the pending step              (conversations:read; the approver, or settings:update)
 *   POST /:id/fulfilment    create the item's tasks again        (conversations:update; after a run that failed)
 *
 * Writes go through @weldsuite/db/lib/desk-catalog (the rules are there);
 * entries are published like linked tickets' (publishDeskLinkChanges).
 * Notifying the next approver and creating the tasks run after the answer
 * (@weldsuite/desk-domain/catalog); the answer's `request` is read before
 * they start. POST …/fulfilment is the one that waits for the tasks. Refusals
 * answer 409 `details.reason`, a field problem 400 `details.field`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  attachDeskCatalogItemSchema,
  decideDeskApprovalSchema,
} from '@weldsuite/core-api-client/schemas/desk-catalog';
import {
  DeskAttributeRejectedError,
  DeskConversationNotFoundError,
  getDeskConversation,
  updateDeskConversationAttributes,
  type DeskConversation,
} from '@weldsuite/db/lib/desk';
import {
  assertDeskRequestStartable,
  DeskCatalogRefusedError,
  decideDeskRequestApproval,
  getDeskCatalogItem,
  getDeskConversationRequest,
  loadDeskFulfilmentRetry,
  startDeskCatalogRequest,
  type DeskCatalogItem,
  type DeskRequestApproval,
} from '@weldsuite/db/lib/desk-catalog';
import type { DeskLinkChange } from '@weldsuite/db/lib/desk-links';
import {
  fulfilDeskCatalogRequest,
  notifyDeskApprover,
  runDeskCatalogFulfilment,
  type DeskCatalogContext,
} from '@weldsuite/desk-domain/catalog';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';
import { rerouteAfterAttributes } from '../../lib/desk-routing';
import { loadAuthor, publishDeskChange } from './index';
import { publishDeskLinkChanges } from './links';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function refusal(c: Ctx, err: unknown, failure: string) {
  if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', err.conversationId);
  if (err instanceof DeskCatalogRefusedError) return error.conflict(c, err.message, { reason: err.reason });
  if (err instanceof DeskAttributeRejectedError) return error.badRequest(c, err.message, { field: err.field });
  console.error(`[desk-api/desk-request] ${failure}:`, err);
  return error.internal(c, failure);
}

const ownMessages = (id: string, changes: DeskLinkChange[]) =>
  changes.filter((change) => change.conversation.id === id).map((change) => change.message);

interface FollowUp {
  conversation: DeskConversation;
  item: DeskCatalogItem | null;
  approval: DeskRequestApproval | null;
  fulfilmentDue: boolean;
}

const catalogContext = (c: Ctx): DeskCatalogContext => ({ env: c.env, clerkOrgId: c.get('clerkOrgId'), generateId });

/** What happens after a step opened or the request was approved, once the answer is out. */
function followUp(c: Ctx, work: FollowUp): void {
  const ctx = catalogContext(c);
  const db = c.get('tenantDb');
  const { conversation, item, approval, fulfilmentDue } = work;
  if (approval) {
    c.executionCtx.waitUntil(notifyDeskApprover(ctx, { db, approval, conversation, item }));
  } else if (fulfilmentDue && item) {
    c.executionCtx.waitUntil(
      fulfilDeskCatalogRequest(ctx, { db, conversation, item, actorUserId: c.get('userId') }).then(() => undefined),
    );
  }
}

/**
 * The request as the answer shows it, read before the follow-up starts: its
 * `fulfilmentStarted` then never depends on how far the tasks got. The
 * follow-up starts even when the read fails (the change itself is written).
 */
async function requestThenFollowUp(c: Ctx, id: string, work: FollowUp) {
  try {
    return await getDeskConversationRequest(c.get('tenantDb'), id);
  } finally {
    followUp(c, work);
  }
}

app.get('/:id/request', requirePermission('conversations:read'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  try {
    if (!(await getDeskConversation(db, id, { includeMessages: false }))) return error.notFound(c, 'Conversation', id);
    return success(c, await getDeskConversationRequest(db, id));
  } catch (err) {
    return refusal(c, err, 'Failed to load the service request');
  }
});

/**
 * Make the conversation a request of an item: the item's ticket type, team and
 * priority are applied first (on the timeline, routing and SLA react as for
 * any change), then the approval flow starts.
 */
app.put('/:id/catalog-item', requirePermission('conversations:update'), zValidator('json', attachDeskCatalogItemSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { catalogItemId } = c.req.valid('json');
  try {
    const found = await getDeskConversation(db, id, { includeMessages: false });
    if (!found) return error.notFound(c, 'Conversation', id);
    const item = await getDeskCatalogItem(db, catalogItemId);
    if (!item) return error.notFound(c, 'Catalogue item', catalogItemId);
    if (!item.isActive) return error.conflict(c, 'This catalogue item is switched off', { reason: 'item_inactive' });
    assertDeskRequestStartable(found.conversation);

    const changes: DeskLinkChange[] = [];
    const attributes = await updateDeskConversationAttributes(db, {
      generateId,
      conversationId: id,
      authorType: 'agent',
      authorId: userId,
      ticketTypeId: item.ticketTypeId,
      departmentId: item.departmentId ?? undefined,
      priority: item.priority ?? undefined,
    });
    if (attributes.message) {
      const change = { conversation: attributes.conversation, message: attributes.message, slaCheckAt: attributes.slaCheckAt };
      changes.push(change);
      await publishDeskLinkChanges(c, [change]);
      // A new type can route it elsewhere (a team the item set itself stays).
      await rerouteAfterAttributes(c, attributes.message, async (next, event) =>
        publishDeskChange(c, next, event, await loadAuthor(c.env, db, next.assigneeId)),
      );
    }

    const started = await startDeskCatalogRequest(db, {
      generateId,
      conversationId: id,
      item,
      actorType: 'agent',
      actorId: userId,
    });
    await publishDeskLinkChanges(c, started.changes);
    if (started.changes.length === 0) {
      publishEntityEvent({
        c,
        entityType: 'desk_conversation',
        action: 'updated',
        entityId: id,
        data: started.conversation as unknown as Record<string, unknown>,
      });
    }
    changes.push(...started.changes);
    const request = await requestThenFollowUp(c, id, {
      conversation: started.conversation,
      item,
      approval: started.pendingApproval,
      fulfilmentDue: started.fulfilmentDue,
    });
    return success(c, { conversation: started.conversation, messages: ownMessages(id, changes), request });
  } catch (err) {
    return refusal(c, err, 'Failed to start the service request');
  }
});

/** Decide the step that waits: its approver, or anyone who manages the catalogue (`settings:update`). */
app.post('/:id/approval', requirePermission('conversations:read'), zValidator('json', decideDeskApprovalSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { decision, comment } = c.req.valid('json');
  try {
    const result = await decideDeskRequestApproval(db, {
      generateId,
      conversationId: id,
      userId: c.get('userId'),
      canManage: await hasContextPermission(c, 'settings:update'),
      decision,
      comment,
    });
    await publishDeskLinkChanges(c, result.changes);
    const item = await getDeskCatalogItem(db, result.decided.catalogItemId);
    const request = await requestThenFollowUp(c, id, {
      conversation: result.conversation,
      item,
      approval: result.nextApproval,
      fulfilmentDue: result.fulfilmentDue,
    });
    return success(c, { conversation: result.conversation, messages: ownMessages(id, result.changes), request });
  } catch (err) {
    return refusal(c, err, 'Failed to decide the approval');
  }
});

/**
 * Create the item's tasks for a request whose fulfilment never finished (the
 * run after the answer failed): approved or without approval, the item still
 * there, no `fulfilment_started` on the timeline. Waits for the tasks and
 * answers how many it created; the tasks a failed run left are kept, not
 * created twice. Publishes what the run after an approval publishes.
 */
app.post('/:id/fulfilment', requirePermission('conversations:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const { conversation, item } = await loadDeskFulfilmentRetry(db, id);
    const result = await runDeskCatalogFulfilment(catalogContext(c), {
      db,
      conversation,
      item,
      actorUserId: c.get('userId'),
    });
    return success(c, { created: result?.created ?? 0 });
  } catch (err) {
    return refusal(c, err, 'Failed to create the tasks');
  }
});

export { app as deskConversationRequestRoutes };
