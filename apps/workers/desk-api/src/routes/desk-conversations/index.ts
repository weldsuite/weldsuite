/**
 * WeldDesk webchat — /api/desk/conversations/*
 *
 * Mutations go through appendDeskMessage / createDeskConversation
 * (@weldsuite/db/lib). Realtime: conversation room + entity events.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  listConversationsQuerySchema,
  getConversationQuerySchema,
  replyToConversationSchema,
  manageConversationSchema,
  updateConversationAttributesSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversations';
import {
  appendDeskMessage,
  deskAuthorFromMember,
  getDeskConversation,
  getDeskConversationCustomFields,
  isPublicDeskMessage,
  listDeskConversations,
  toPublicDeskConversation,
  toPublicDeskMessage,
  updateDeskConversationAttributes,
  DeskAttributeRejectedError,
  DeskConversationNotFoundError,
  isDeskSchemaMissing,
  type DeskAuthorInfo,
  type DeskConversation,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import * as schema from '@weldsuite/db/schema';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { sendDeskEmailReply } from '../../lib/desk-email';
import { withoutTrailingSlash } from '../../lib/url';
import { notifyAssigned } from '../../lib/notify';
import { markDeskSlaDue } from '../../lib/sla-due';
import { getDeskAttributeOptions } from '../../services/desk-attributes';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function loadAuthor(db: Variables['tenantDb'], userId: string | null | undefined) {
  const authors = new Map<string, DeskAuthorInfo>();
  if (!userId) return authors;
  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name, picture: schema.workspaceMembers.picture })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .limit(1);
    if (member) authors.set(userId, deskAuthorFromMember(member));
  } catch (err) {
    console.error('[app-api/desk-conversations] author lookup failed:', err);
  }
  return authors;
}

/**
 * Fan a change out live:
 *   - ConversationRoom: the visitor's widget (and other agents viewing the
 *     thread). Visitors are connected to this room, so internal notes are
 *     NEVER published here.
 *   - WorkspaceHub desk_conversation / desk_message: every agent's inbox list
 *     and open thread, including notes. Published directly (not only via the
 *     entity-event queue) so the inbox updates in the same second.
 */
async function publishDeskChange(
  c: { env: Env; get: (key: 'clerkOrgId') => string },
  conversation: DeskConversation,
  message: DeskMessage,
  authors: Map<string, DeskAuthorInfo>,
) {
  if (!c.env.REALTIME) return;
  const rt = new RealtimePublisher(c.env.REALTIME, { internalSecret: c.env.REALTIME_INTERNAL_SECRET });
  const orgId = c.get('clerkOrgId');
  const jobs: Promise<unknown>[] = [
    rt.publish(orgId, 'desk_conversation', 'updated', conversation, message.authorId ?? 'system'),
    rt.publish(orgId, 'desk_message', 'created', message, message.authorId ?? 'system'),
  ];

  if (isPublicDeskMessage(message)) {
    const record = toPublicDeskMessage(message, authors);
    if (message.kind === 'message') {
      jobs.push(
        rt.conversationPublish(conversation.id, {
          type: 'message',
          id: message.id,
          content: message.body ?? '',
          senderId: message.authorId ?? '',
          senderName: record.authorName ?? 'Support',
          senderAvatar: record.authorAvatar ?? undefined,
          senderType: message.authorType,
          ts: Date.now(),
          record,
        }),
      );
    } else {
      jobs.push(
        rt.conversationPublish(conversation.id, {
          type: 'system',
          event: record.eventType ?? 'event',
          data: {
            state: conversation.state,
            conversation: toPublicDeskConversation(conversation, authors),
            record,
          },
          ts: Date.now(),
        }),
      );
    }
  }

  const results = await Promise.allSettled(jobs);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[app-api/desk-conversations] realtime publish failed:', result.reason);
    }
  }
}

app.get('/', requirePermission('conversations:read'), zValidator('query', listConversationsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const query = c.req.valid('query');
  try {
    const result = await listDeskConversations(db, query);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/desk-conversations] list failed:', err);
    if (isDeskSchemaMissing(err)) {
      return error.unavailable(c, 'WeldDesk schema is not applied. Run tenant migration 0185_welddesk_webchat.');
    }
    return error.internal(c, 'Failed to list conversations');
  }
});

/** Ticket types, their fields, teams and tags in use, for the details panel. */
app.get('/attributes', requirePermission('conversations:read'), async (c) => {
  try {
    return success(c, await getDeskAttributeOptions(c.get('tenantDb')));
  } catch (err) {
    console.error('[desk-api/desk-conversations] attribute options failed:', err);
    return error.internal(c, 'Failed to load conversation attributes');
  }
});

app.get('/:id', requirePermission('conversations:read'), zValidator('query', getConversationQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { include } = c.req.valid('query');
  try {
    const result = await getDeskConversation(db, id, { includeMessages: include === 'messages' });
    if (!result) return error.notFound(c, 'Conversation', id);
    const customFields = await getDeskConversationCustomFields(db, result.conversation);
    const conversation = { ...result.conversation, customFields };
    return success(c, include === 'messages' ? { ...conversation, messages: result.messages } : conversation);
  } catch (err) {
    console.error('[app-api/desk-conversations] get failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

/**
 * Files agents attach. Same passive allow-list as widget uploads: the object
 * is served from the public bucket domain, so SVG or HTML would run script
 * on that host.
 */
const ATTACHMENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Object name the upload route generates; no `/`, `..`, `?` or `#` can sneak in. */
const UPLOADED_NAME = /^\d+_att_[A-Za-z0-9]+_[A-Za-z0-9._-]+$/;

/** Where a conversation's agent files live: R2 key prefix and its public URL. */
function attachmentLocation(env: Env, clerkOrgId: string, conversationId: string) {
  if (!env.R2_PUBLIC_URL) return null;
  const keyPrefix = `desk/${clerkOrgId}/${conversationId}/`;
  return { keyPrefix, urlPrefix: `${withoutTrailingSlash(env.R2_PUBLIC_URL)}/${keyPrefix}` };
}

app.post('/:id/attachments', requirePermission('conversations:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const location = attachmentLocation(c.env, c.get('clerkOrgId'), id);
  if (!c.env.STORAGE || !location) return error.unavailable(c, 'File upload is not configured');

  const [exists] = await db
    .select({ id: schema.deskConversations.id })
    .from(schema.deskConversations)
    .where(eq(schema.deskConversations.id, id))
    .limit(1);
  if (!exists) return error.notFound(c, 'Conversation', id);

  let file: File | string | null;
  try {
    file = (await c.req.formData()).get('file') as File | string | null;
  } catch {
    return error.badRequest(c, 'Expected multipart form data with a file');
  }
  if (!file || typeof file === 'string') return error.badRequest(c, 'No file provided');
  if (file.size > MAX_ATTACHMENT_BYTES) return error.badRequest(c, 'File too large (max 10 MB)');
  if (!ATTACHMENT_TYPES.has(file.type)) return error.badRequest(c, `File type not allowed: ${file.type || 'unknown'}`);

  const safeName = file.name.replaceAll(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120) || 'file';
  const fileName = `${Date.now()}_${generateId('att')}_${safeName}`;
  try {
    await c.env.STORAGE.put(`${location.keyPrefix}${fileName}`, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type, contentDisposition: `inline; filename="${safeName}"` },
    });
  } catch (err) {
    console.error('[desk-api/desk-conversations] attachment upload failed:', err);
    return error.internal(c, 'Failed to upload file');
  }

  const attachment = {
    name: file.name.slice(0, 255) || safeName,
    url: `${location.urlPrefix}${fileName}`,
    contentType: file.type,
    filesize: file.size,
  };
  publishEntityEvent({
    c,
    entityType: 'desk_attachment',
    action: 'created',
    entityId: fileName,
    data: { ...attachment, conversationId: id },
  });
  return success(c, attachment, 201);
});

app.post('/:id/reply', requirePermission('conversations:update'), zValidator('json', replyToConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  if (data.attachments?.length) {
    // Only files uploaded to this conversation: a reply must not make the
    // inbox (or the customer's email) link to an arbitrary URL.
    const location = attachmentLocation(c.env, c.get('clerkOrgId'), id);
    const owned = (url: string) =>
      location !== null &&
      url.startsWith(location.urlPrefix) &&
      UPLOADED_NAME.test(url.slice(location.urlPrefix.length));
    if (!location || data.attachments.some((a) => !owned(a.url))) {
      return error.badRequest(c, 'Attachments must be uploaded to this conversation first');
    }
  }
  try {
    const { conversation, message, slaCheckAt } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: data.kind,
      authorType: 'agent',
      authorId: userId,
      body: data.body || null,
      attachments: data.attachments,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
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
    const authors = await loadAuthor(db, userId);
    c.executionCtx.waitUntil(publishDeskChange(c, conversation, message, authors));
    if (conversation.channel === 'email' && data.kind === 'message') {
      try {
        await sendDeskEmailReply(c.env, db, conversation, message, {
          clerkOrgId: c.get('clerkOrgId'),
          waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        });
      } catch (err) {
        console.error('[app-api/desk-conversations] outbound email failed:', err);
      }
    }
    return success(c, { conversation, message }, 201);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] reply failed:', err);
    return error.internal(c, 'Failed to reply');
  }
});

app.post('/:id/manage', requirePermission('conversations:update'), zValidator('json', manageConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    let eventType: 'closed' | 'reopened' | 'assigned' | 'unassigned';
    let assigneeId: string | null | undefined;
    // Read before the write: the notification goes out only when the assignee
    // actually changes, not when an agent is re-assigned a conversation they own.
    const [before] = await db
      .select({ assigneeId: schema.deskConversations.assigneeId })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, id))
      .limit(1);
    if (data.action === 'close') eventType = 'closed';
    else if (data.action === 'open') eventType = 'reopened';
    else if (data.assigneeId) {
      eventType = 'assigned';
      assigneeId = data.assigneeId;
    } else {
      eventType = 'unassigned';
      assigneeId = null;
    }

    const { conversation, message, slaCheckAt } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'event',
      authorType: 'agent',
      authorId: userId,
      metadata: { eventType, assigneeId: assigneeId ?? null },
      assigneeId,
    });

    const action = data.action === 'assign' ? 'assigned' : 'state_changed';
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action,
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
    const authors = await loadAuthor(db, conversation.assigneeId);
    c.executionCtx.waitUntil(publishDeskChange(c, conversation, message, authors));
    if (eventType === 'assigned') {
      notifyAssigned(c, {
        assigneeId,
        previousAssigneeId: before?.assigneeId,
        kind: 'conversation',
        entityId: conversation.id,
        subject: conversation.title || conversation.name || conversation.email,
        reference: `#${conversation.conversationNumber}`,
        assignedByUserId: userId,
      });
    }
    return success(c, { conversation, message });
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] manage failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

/**
 * Set the conversation's ticket fields: type, priority, tags, team and the
 * type's custom fields. The change goes on the timeline as an internal event
 * (never to the visitor); a request that changes nothing writes nothing.
 */
app.patch('/:id', requirePermission('conversations:update'), zValidator('json', updateConversationAttributesSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { conversation, message, customFields, slaCheckAt } = await updateDeskConversationAttributes(db, {
      generateId,
      conversationId: id,
      authorType: 'agent',
      authorId: userId,
      ...data,
    });
    // Other agents' open threads take the field values from the hub event.
    const withFields = { ...conversation, customFields };
    if (message) {
      publishEntityEvent({
        c,
        entityType: 'desk_conversation',
        action: 'updated',
        entityId: conversation.id,
        data: withFields as unknown as Record<string, unknown>,
      });
      publishEntityEvent({
        c,
        entityType: 'desk_message',
        action: 'created',
        entityId: message.id,
        data: message as unknown as Record<string, unknown>,
      });
      c.executionCtx.waitUntil(publishDeskChange(c, withFields, message, new Map()));
      markDeskSlaDue(c, slaCheckAt);
    }
    return success(c, { conversation: withFields, message });
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    if (err instanceof DeskAttributeRejectedError) return error.badRequest(c, err.message, { field: err.field });
    console.error('[desk-api/desk-conversations] attribute update failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

export { app as deskConversationsRoutes };
