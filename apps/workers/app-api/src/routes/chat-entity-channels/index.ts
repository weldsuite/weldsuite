/**
 * WeldChat entity channel routes — flat /api/chat-entity-channels/* surface.
 *
 * Lets any business entity (a task, project, contact, …) have its own chat
 * channel that appears in WeldChat like a normal channel. The channel is
 * created lazily on the first message via POST /:entityType/:entityId/messages.
 *
 *   GET  /:entityType/:entityId/channel   — linked channel or null (no create)
 *   POST /:entityType/:entityId/messages  — get-or-create channel + post a message
 *   GET  /:entityType/:entityId/detail    — provider-specific entity details
 *   GET  /:entityType                     — list visible channels of a type
 *
 * WeldChat streams over its own ChatRoom DO / realtime path, not the
 * entity-event bus — no entity events are published here. Message fan-out
 * happens via postChatMessage (REALTIME binding).
 *
 * Permissions: channels:read (read) | messages:create (post).
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { sendEntityMessageSchema } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import {
  findEntityChannel,
  getEntityProvider,
  getOrCreateEntityChannel,
} from '../../services/chat/entity-channels';
import { postChatMessage } from '../../services/chat/post-message';

type AppEnv = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnv>();

// requirePermission() from @weldsuite/permissions is typed with a loose Hono
// generic which collides with multi-param route inference here. Cast once and
// reuse — the runtime behaviour is identical.
const readPerm = requirePermission('channels:read') as unknown as MiddlewareHandler<AppEnv>;
const writePerm = requirePermission('messages:create') as unknown as MiddlewareHandler<AppEnv>;

/**
 * GET /:entityType/:entityId/channel — channel linked to an entity, or null.
 * Never creates the channel; use POST /messages for lazy creation.
 */
app.get('/:entityType/:entityId/channel', readPerm, async (c) => {
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  const provider = getEntityProvider(entityType);
  if (!provider) return error.badRequest(c, `Unknown entity type: ${entityType}`);

  const db = c.get('tenantDb');
  try {
    if (!(await provider.canAccess({ db, actingUserId: userId, entityId }))) {
      return error.forbidden(c, 'You do not have access to this entity');
    }
    const channel = await findEntityChannel(db, entityType, entityId);
    // A missing channel isn't an error — entity channels are lazily created on
    // first message. Return null so the client can render an empty state.
    return success(c, channel ?? null);
  } catch (err) {
    console.error('[app-api/chat-entity-channels] fetch channel failed:', err);
    return error.internal(c, 'Failed to fetch entity channel');
  }
});

/**
 * POST /:entityType/:entityId/messages — get-or-create the channel and post.
 */
app.post('/:entityType/:entityId/messages', writePerm, zValidator('json', sendEntityMessageSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');
  const input = c.req.valid('json');

  const provider = getEntityProvider(entityType);
  if (!provider) return error.badRequest(c, `Unknown entity type: ${entityType}`);

  const db = c.get('tenantDb');
  try {
    if (!(await provider.canAccess({ db, actingUserId: userId, entityId }))) {
      return error.forbidden(c, 'You do not have access to this entity');
    }

    const { channel, created } = await getOrCreateEntityChannel({
      db,
      entityType,
      entityId,
      actingUserId: userId,
    });

    const message = await postChatMessage(
      { db, env: c.env, orgId, channelId: channel.id, authorUserId: userId },
      input,
    );

    return success(c, { channel, message, createdChannel: created }, 201);
  } catch (err) {
    console.error('[app-api/chat-entity-channels] post message failed:', err);
    return error.internal(c, 'Failed to post entity message');
  }
});

/**
 * GET /:entityType/:entityId/detail — provider-specific entity details.
 */
app.get('/:entityType/:entityId/detail', readPerm, async (c) => {
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  const provider = getEntityProvider(entityType);
  if (!provider) return error.badRequest(c, `Unknown entity type: ${entityType}`);
  if (!provider.resolveDetail) {
    return error.badRequest(c, `Provider ${entityType} does not expose detail data`);
  }

  const db = c.get('tenantDb');
  try {
    if (!(await provider.canAccess({ db, actingUserId: userId, entityId }))) {
      return error.forbidden(c, 'You do not have access to this entity');
    }
    const detail = await provider.resolveDetail({ db, actingUserId: userId, entityId });
    return success(c, detail ?? null);
  } catch (err) {
    console.error('[app-api/chat-entity-channels] fetch detail failed:', err);
    return error.internal(c, 'Failed to fetch entity detail');
  }
});

/**
 * GET /:entityType — list channels of a given entity type the caller can see.
 */
app.get('/:entityType', readPerm, async (c) => {
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');

  const provider = getEntityProvider(entityType);
  if (!provider) return error.badRequest(c, `Unknown entity type: ${entityType}`);

  const db = c.get('tenantDb');
  const { chatChannels, chatChannelMembers } = schema;

  try {
    const memberships = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));
    const memberChannelIds = new Set(memberships.map((m) => m.channelId));

    const rows = await db
      .select()
      .from(chatChannels)
      .where(and(eq(chatChannels.entityType, entityType), isNull(chatChannels.deletedAt)))
      .orderBy(desc(chatChannels.lastMessageAt));

    // Entity channels are private by default — only show ones the caller joined.
    const visible = rows.filter((row) => memberChannelIds.has(row.id));
    return success(c, visible);
  } catch (err) {
    console.error('[app-api/chat-entity-channels] list failed:', err);
    return error.internal(c, 'Failed to list entity channels');
  }
});

export const chatEntityChannelsRoutes = app;
