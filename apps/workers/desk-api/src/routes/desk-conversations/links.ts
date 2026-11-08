/**
 * WeldDesk linked tickets — /api/desk/conversations/:id/{links,parent,merge,
 * major-incident,incident-update}: parent/child links (one level), major
 * incidents with an update to every linked customer, and merging duplicates.
 *
 * Writes go through @weldsuite/db/lib/desk-links (the rules are there). Every
 * timeline entry is published like the inbox routes publish theirs: the
 * workspace hub, the visitor's conversation room for public entries, and the
 * entity events, in the order they were written. Mounted next to the inbox
 * routes in src/index.ts. Permissions: conversations:read | conversations:update.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  mergeDeskConversationSchema,
  postDeskIncidentUpdateSchema,
  setDeskConversationParentSchema,
  setDeskMajorIncidentSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversation-links';
import { DeskConversationNotFoundError, type DeskAuthorInfo } from '@weldsuite/db/lib/desk';
import {
  DeskLinkRejectedError,
  getDeskConversationLinks,
  mergeDeskConversations,
  postDeskIncidentUpdate,
  setDeskConversationParent,
  setDeskMajorIncident,
  type DeskLinkChange,
} from '@weldsuite/db/lib/desk-links';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';
import { sendDeskEmailReply } from '../../lib/desk-email';
import { markDeskSlaDue } from '../../lib/sla-due';
import { loadAuthor, publishDeskChange } from './index';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Publish each change in order: its entity events (a close is
 * `state_changed`, anything else `updated`), the SLA due time, and the
 * realtime fan-out. A chat reply carries its author; an event the assignee.
 */
export async function publishDeskLinkChanges(c: Ctx, changes: DeskLinkChange[]): Promise<void> {
  const authorCache = new Map<string, Map<string, DeskAuthorInfo>>();
  const authorsFor = async (userId: string | null | undefined) => {
    const key = userId ?? '';
    const cached = authorCache.get(key);
    if (cached) return cached;
    const authors = await loadAuthor(c.get('tenantDb'), userId);
    authorCache.set(key, authors);
    return authors;
  };
  for (const { conversation, message, slaCheckAt } of changes) {
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: message.metadata?.eventType === 'closed' ? 'state_changed' : 'updated',
      entityId: conversation.id,
      data: conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: message as unknown as Record<string, unknown>,
    });
    markDeskSlaDue(c, slaCheckAt);
    const authors = await authorsFor(message.kind === 'message' ? message.authorId : conversation.assigneeId);
    c.executionCtx.waitUntil(publishDeskChange(c, conversation, message, authors));
  }
}

/** The answer to a refusal, a missing conversation or a failure. */
function refusal(c: Ctx, err: unknown, failure: string) {
  if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', err.conversationId);
  if (err instanceof DeskLinkRejectedError) return error.conflict(c, err.message, { reason: err.reason });
  console.error(`[desk-api/desk-conversations] ${failure}:`, err);
  return error.internal(c, failure);
}

/** The entries a change wrote on `id`'s own timeline. */
const ownMessages = (id: string, changes: DeskLinkChange[]) =>
  changes.filter((change) => change.conversation.id === id).map((change) => change.message);

app.get('/:id/links', requirePermission('conversations:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const links = await getDeskConversationLinks(c.get('tenantDb'), id);
    if (!links) return error.notFound(c, 'Conversation', id);
    return success(c, links);
  } catch (err) {
    return refusal(c, err, 'Failed to load linked tickets');
  }
});

/** Link the conversation to a parent, or unlink it (`parentId: null`). */
app.put('/:id/parent', requirePermission('conversations:update'), zValidator('json', setDeskConversationParentSchema), async (c) => {
  const id = c.req.param('id');
  const { parentId } = c.req.valid('json');
  try {
    const result = await setDeskConversationParent(c.get('tenantDb'), {
      generateId,
      conversationId: id,
      parentId,
      authorId: c.get('userId'),
    });
    await publishDeskLinkChanges(c, result.changes);
    return success(c, { conversation: result.conversation, messages: ownMessages(id, result.changes) });
  } catch (err) {
    return refusal(c, err, 'Failed to link the conversation');
  }
});

/** Merge this duplicate into `targetId` (same customer only). */
app.post('/:id/merge', requirePermission('conversations:update'), zValidator('json', mergeDeskConversationSchema), async (c) => {
  const id = c.req.param('id');
  const { targetId } = c.req.valid('json');
  try {
    const result = await mergeDeskConversations(c.get('tenantDb'), {
      generateId,
      sourceId: id,
      targetId,
      authorId: c.get('userId'),
    });
    await publishDeskLinkChanges(c, result.changes);
    return success(c, {
      conversation: result.conversation,
      target: result.target,
      messages: ownMessages(id, result.changes),
    });
  } catch (err) {
    return refusal(c, err, 'Failed to merge the conversation');
  }
});

/** Mark or unmark a major incident; unmarking unlinks its children. */
app.put('/:id/major-incident', requirePermission('conversations:update'), zValidator('json', setDeskMajorIncidentSchema), async (c) => {
  const id = c.req.param('id');
  const { isMajorIncident } = c.req.valid('json');
  try {
    const result = await setDeskMajorIncident(c.get('tenantDb'), {
      generateId,
      conversationId: id,
      isMajorIncident,
      authorId: c.get('userId'),
    });
    await publishDeskLinkChanges(c, result.changes);
    return success(c, { conversation: result.conversation, messages: ownMessages(id, result.changes) });
  } catch (err) {
    return refusal(c, err, 'Failed to update the major incident');
  }
});

/**
 * "Post an update to all linked customers": one reply on the incident and on
 * each open child, delivered per channel like a reply (messenger: the
 * visitor's room; email: sendDeskEmailReply; other channels: the timeline).
 */
app.post('/:id/incident-update', requirePermission('conversations:update'), zValidator('json', postDeskIncidentUpdateSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { body } = c.req.valid('json');
  try {
    const result = await postDeskIncidentUpdate(db, { generateId, incidentId: id, body, authorId: c.get('userId') });
    await publishDeskLinkChanges(c, result.changes);
    for (const { conversation, message } of result.changes) {
      if (conversation.channel !== 'email') continue;
      try {
        await sendDeskEmailReply(c.env, db, conversation, message, {
          clerkOrgId: c.get('clerkOrgId'),
          waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        });
      } catch (err) {
        console.error('[desk-api/desk-conversations] incident update email failed:', err);
      }
    }
    const [own] = result.changes;
    if (!own) return error.internal(c, 'Failed to post the update');
    return success(c, { conversation: result.conversation, message: own.message, delivered: result.changes.length - 1 }, 201);
  } catch (err) {
    return refusal(c, err, 'Failed to post the update');
  }
});

export { app as deskConversationLinkRoutes };
