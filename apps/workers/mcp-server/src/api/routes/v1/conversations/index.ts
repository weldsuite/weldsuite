/**
 * /v1/conversations (MCP copy of external-api's route) — the WeldDesk inbox (`desk_conversations`), the one
 * agents work in. Integrations open conversations here: an alert, a form, a
 * ticket from another system. `externalId` keeps repeats of the same alert on
 * one conversation. Writes go through `@weldsuite/desk-domain/inbox`, which
 * also auto-assigns, notifies the team and publishes the entity events.
 *
 * Before this the route served `helpdesk_conversations`, which no screen shows.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  getDeskConversation,
  listDeskConversations,
  listDeskMessages,
  type DeskApiSource,
} from '@weldsuite/db/lib/desk';
import {
  addDeskConversationMessageFromApi,
  openDeskApiConversation,
  updateDeskConversationFromApi,
  DeskAttributeRejectedError,
  DeskConversationNotFoundError,
  DeskReplyChannelError,
  type DeskInboxActor,
  type DeskInboxDeps,
} from '@weldsuite/desk-domain/inbox';
import {
  addDeskConversationMessageSchema,
  getConversationQuerySchema,
  listConversationsQuerySchema,
  openDeskConversationSchema,
  updateDeskConversationSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversations';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, success, cursorPagination } from '../../../lib/response';

/** What this worker's writes are recorded as on the timeline (`metadata.via`). */
const VIA: DeskApiSource = 'mcp';

/** The request's `waitUntil`; undefined without an execution context (tests), so the work is awaited. */
function backgroundRunner(c: Context<HonoEnv>): DeskInboxDeps['waitUntil'] {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

/** Inbox writes for this request: its db, bindings and entity-event publisher. */
export function deskInboxDeps(c: Context<HonoEnv>): DeskInboxDeps {
  return {
    db: c.get('tenantDb'),
    env: c.env,
    clerkOrgId: c.get('clerkOrgId') ?? c.get('workspaceId'),
    generateId,
    emit: (event) => publishEntityEvent({ c, ...event }),
    waitUntil: backgroundRunner(c),
  };
}

/** A personal key acts as its member; a workspace or app key as a bot. */
export function deskInboxActor(c: Context<HonoEnv>): DeskInboxActor {
  const session = c.get('apiSession');
  return session.userId
    ? { authorType: 'agent', authorId: session.userId }
    : { authorType: 'bot', authorId: session.keyId };
}

/**
 * `search` is what the old /v1/conversations took and what the MCP name lookup
 * sends; the inbox calls it `q`. Without it a lookup would list everything.
 */
const listQuerySchema = listConversationsQuerySchema.extend({ search: z.string().trim().max(200).optional() });

const app = new Hono<HonoEnv>();

app.get('/', requireScope('conversations:read'), zValidator('query', listQuerySchema), async (c) => {
  const { search, ...query } = c.req.valid('query');
  const result = await listDeskConversations(c.get('tenantDb'), { ...query, q: query.q ?? search });
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('conversations:read'), zValidator('query', getConversationQuerySchema), async (c) => {
  const id = c.req.param('id');
  const { include } = c.req.valid('query');
  const result = await getDeskConversation(c.get('tenantDb'), id, { includeMessages: include === 'messages' });
  if (!result) return error.notFound(c, 'Conversation', id);
  return success(c, include === 'messages' ? { ...result.conversation, messages: result.messages } : result.conversation);
});

/**
 * Open a conversation, or add the message to the one that already carries
 * `externalId`: 201 when it is new, 200 when it landed on an existing one.
 */
app.post('/', requireScope('conversations:write'), zValidator('json', openDeskConversationSchema), async (c) => {
  const { ticketTypeId, priority, tags, departmentId, ...message } = c.req.valid('json');
  try {
    const result = await openDeskApiConversation(deskInboxDeps(c), {
      ...message,
      via: VIA,
      fields: { ticketTypeId, priority, tags, departmentId },
      actor: deskInboxActor(c),
    });
    return success(c, result.conversation, result.created ? 201 : 200);
  } catch (err) {
    if (err instanceof DeskAttributeRejectedError) return error.badRequest(c, err.message, { field: err.field });
    throw err;
  }
});

app.patch('/:id', requireScope('conversations:write'), zValidator('json', updateDeskConversationSchema), async (c) => {
  const id = c.req.param('id');
  const { state, assigneeId, ...fields } = c.req.valid('json');
  try {
    const { conversation, customFields } = await updateDeskConversationFromApi(deskInboxDeps(c), {
      conversationId: id,
      state,
      assigneeId,
      fields,
      actor: deskInboxActor(c),
    });
    return success(c, customFields ? { ...conversation, customFields } : conversation);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    if (err instanceof DeskAttributeRejectedError) return error.badRequest(c, err.message, { field: err.field });
    throw err;
  }
});

app.get('/:id/messages', requireScope('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const found = await getDeskConversation(db, id);
  if (!found) return error.notFound(c, 'Conversation', id);
  const messages = await listDeskMessages(db, id);
  return list(c, messages, cursorPagination(messages.length, false, null));
});

app.post(
  '/:id/messages',
  requireScope('conversations:write'),
  zValidator('json', addDeskConversationMessageSchema),
  async (c) => {
    const id = c.req.param('id');
    try {
      const { message } = await addDeskConversationMessageFromApi(deskInboxDeps(c), {
        conversationId: id,
        ...c.req.valid('json'),
        actor: deskInboxActor(c),
      });
      return success(c, message, 201);
    } catch (err) {
      if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
      if (err instanceof DeskReplyChannelError) return error.conflict(c, err.message);
      throw err;
    }
  },
);

export default app;
