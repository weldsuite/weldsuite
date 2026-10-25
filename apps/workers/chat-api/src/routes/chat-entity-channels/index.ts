/**
 * WeldChat entity channel routes ("record chats") — flat /api/chat-entity-channels/* surface.
 *
 * Lets any business record (a company, person, task, project, domain) have its
 * own chat channel that appears in WeldChat for the people who follow it. The
 * channel is created lazily on the first message (or the first follow).
 *
 *   GET    /                                    — record chats, cursor paginated (?type=&filter=&search=)
 *   GET    /summary                             — per type: followed / unread / mention counts
 *   GET    /:entityType/:entityId/channel       — linked channel or null (no create)
 *   POST   /:entityType/:entityId/messages      — get-or-create channel + post a message
 *   POST   /:entityType/:entityId/follow        — follow (get-or-create channel)
 *   DELETE /:entityType/:entityId/follow        — unfollow
 *   GET    /:entityType/:entityId/detail        — provider-specific entity details
 *
 * crm-api forwards `/api/companies/:id/chat/*` and `/api/people/:id/chat/*`
 * here (types `company` and `person`).
 *
 * Following a chat is a `chat_channel_members` row. New followers get a
 * `channel_new` push on their user topic so the chat appears in their sidebar
 * live. Messages stream over WeldChat's own ChatRoom DO / realtime path; the
 * roster changes publish the same `chat_channel` entity events as
 * `/api/channels`: `created` when a record chat is created, `joined` on
 * follow and `left` on unfollow.
 *
 * Permissions: channels:read (read, follow) | messages:create (post), plus the
 * record type's own permission (provider `requiredPermission`, e.g.
 * `companies:read`) and the provider's record check.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import {
  listEntityChannelsQuerySchema,
  sendEntityMessageSchema,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { publishChatMemberLeft } from '@weldsuite/chat-domain/realtime/weldchat-publisher';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  addFollowers,
  announceNewFollowers,
  canAccessEntity,
  findEntityChannel,
  getEntityProvider,
  getOrCreateEntityChannel,
  listRecordChatProviders,
  removeFollower,
  type EntityChannelProvider,
  type PermissionCheck,
} from '../../services/chat/entity-channels';
import { listRecordChats, summarizeRecordChats } from '../../services/chat/entity-channels/record-chat-list';
import { ChatFeatureError, postChatMessage } from '../../services/chat/post-message';

type AppEnv = { Bindings: Env; Variables: Variables };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

// requirePermission() from @weldsuite/permissions is typed with a loose Hono
// generic which collides with multi-param route inference here. Cast once and
// reuse — the runtime behaviour is identical.
const readPerm = requirePermission('channels:read') as unknown as MiddlewareHandler<AppEnv>;
const writePerm = requirePermission('messages:create') as unknown as MiddlewareHandler<AppEnv>;

/** The caller's permission check, app- and deny-aware like requirePermission. */
function callerCan(c: AppContext): PermissionCheck {
  return (permission) => hasContextPermission(c, permission);
}

/**
 * Publish a `chat_channel` entity event without letting a publish failure turn
 * a done mutation into a 500 (same as the `/api/channels` routes).
 */
function publishChannelEvent(
  c: AppContext,
  action: 'created' | 'joined' | 'left',
  channel: { id: string; name?: string; type?: string },
): void {
  try {
    publishEntityEvent({
      c,
      entityType: 'chat_channel',
      action,
      entityId: channel.id,
      data: { id: channel.id, name: channel.name, type: channel.type },
    });
  } catch (e) {
    console.error('[chat-api/chat-entity-channels] entity event publish failed:', e);
  }
}

function waitUntilFor(c: AppContext): (p: Promise<unknown>) => void {
  return (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p.catch(() => undefined);
    }
  };
}

/** The provider for `:entityType`, and whether the caller may see `:entityId`. */
async function resolveAccess(
  c: AppContext,
): Promise<{ provider: EntityChannelProvider; entityType: string; entityId: string } | Response> {
  const entityType = c.req.param('entityType') ?? '';
  const entityId = c.req.param('entityId') ?? '';
  const provider = getEntityProvider(entityType);
  if (!provider) return error.badRequest(c, `Unknown entity type: ${entityType}`);
  const allowed = await canAccessEntity(provider, {
    db: c.get('tenantDb'),
    actingUserId: c.get('userId'),
    entityId,
    can: callerCan(c),
  });
  if (!allowed) return error.forbidden(c, 'You do not have access to this entity');
  return { provider, entityType, entityId };
}

/**
 * GET / — record chats of the types the caller may read, most recent activity
 * first. `filter=following` (default) is the sidebar; `unread`, `mentions` and
 * `all` (every record chat the caller may read) are for the record chats page.
 */
app.get('/', readPerm, zValidator('query', listEntityChannelsQuerySchema), async (c) => {
  const q = c.req.valid('query');
  let providers = listRecordChatProviders();
  if (q.type) {
    const provider = getEntityProvider(q.type);
    if (!provider || provider.legacy) return error.badRequest(c, `Unknown entity type: ${q.type}`);
    providers = [provider];
  }

  try {
    const result = await listRecordChats({
      db: c.get('tenantDb'),
      userId: c.get('userId'),
      can: callerCan(c),
      providers,
      filter: q.filter,
      search: q.search || undefined,
      cursor: q.cursor,
      limit: q.limit,
    });
    return list(c, result.items, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] list failed:', err);
    return error.internal(c, 'Failed to list entity channels');
  }
});

/**
 * GET /summary — per record type the caller may read: followed, unread and
 * mention counts, for the sidebar group headers. Mounted before the
 * `/:entityType/...` routes.
 */
app.get('/summary', readPerm, async (c) => {
  try {
    const summary = await summarizeRecordChats({
      db: c.get('tenantDb'),
      userId: c.get('userId'),
      can: callerCan(c),
      providers: listRecordChatProviders(),
    });
    return success(c, summary);
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] summary failed:', err);
    return error.internal(c, 'Failed to summarise entity channels');
  }
});

/**
 * GET /:entityType/:entityId/channel — channel linked to an entity, or null.
 * Never creates the channel; use POST /messages for lazy creation.
 */
app.get('/:entityType/:entityId/channel', readPerm, async (c) => {
  try {
    const access = await resolveAccess(c);
    if (access instanceof Response) return access;
    const channel = await findEntityChannel(c.get('tenantDb'), access.entityType, access.entityId);
    // A missing channel isn't an error — entity channels are lazily created on
    // first message. Return null so the client can render an empty state.
    return success(c, channel ?? null);
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] fetch channel failed:', err);
    return error.internal(c, 'Failed to fetch entity channel');
  }
});

/**
 * POST /:entityType/:entityId/messages — get-or-create the channel and post.
 * Posting follows the chat (postChatMessage), and a new channel's default
 * members follow it from the start.
 */
app.post('/:entityType/:entityId/messages', writePerm, zValidator('json', sendEntityMessageSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const db = c.get('tenantDb');

  let channelId: string | undefined;
  try {
    const access = await resolveAccess(c);
    if (access instanceof Response) return access;

    const { channel, created, newFollowerIds } = await getOrCreateEntityChannel({
      db,
      entityType: access.entityType,
      entityId: access.entityId,
      actingUserId: userId,
      can: callerCan(c),
    });
    channelId = channel.id;

    const message = await postChatMessage(
      { db, env: c.env, orgId, channelId: channel.id, authorUserId: userId, waitUntil: waitUntilFor(c) },
      input,
    );
    await announceNewFollowers(c.env, orgId, channel, newFollowerIds);
    if (created) publishChannelEvent(c, 'created', channel);

    return success(c, { channel, message, createdChannel: created }, 201);
  } catch (err) {
    if (err instanceof ChatFeatureError) {
      if (err.status === 404) return error.notFound(c, 'Channel', channelId);
      return error.badRequest(c, err.message);
    }
    console.error('[chat-api/chat-entity-channels] post message failed:', err);
    return error.internal(c, 'Failed to post entity message');
  }
});

/**
 * POST /:entityType/:entityId/follow — follow a record's chat, creating the
 * channel when nobody has written in it yet (its default members then follow
 * it too).
 */
app.post('/:entityType/:entityId/follow', readPerm, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const db = c.get('tenantDb');
  try {
    const access = await resolveAccess(c);
    if (access instanceof Response) return access;

    const { channel, created, newFollowerIds } = await getOrCreateEntityChannel({
      db,
      entityType: access.entityType,
      entityId: access.entityId,
      actingUserId: userId,
      can: callerCan(c),
    });
    const added = await addFollowers(db, channel.id, [userId]);
    await announceNewFollowers(c.env, orgId, channel, [...new Set([...newFollowerIds, ...added])]);
    if (created) publishChannelEvent(c, 'created', channel);
    if (created || added.length > 0) publishChannelEvent(c, 'joined', channel);

    return success(c, { channel, following: true, createdChannel: created });
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] follow failed:', err);
    return error.internal(c, 'Failed to follow entity channel');
  }
});

/**
 * DELETE /:entityType/:entityId/follow — stop following. Takes the chat out of
 * the caller's sidebar; it stays on the record. Allowed without access to the
 * record, so a user who lost access can still clear it. 204 whether or not
 * the chat exists or was followed.
 */
app.delete('/:entityType/:entityId/follow', readPerm, async (c) => {
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');
  if (!getEntityProvider(entityType)) return error.badRequest(c, `Unknown entity type: ${entityType}`);

  const userId = c.get('userId');
  const db = c.get('tenantDb');
  try {
    const channel = await findEntityChannel(db, entityType, entityId);
    if (channel && (await removeFollower(db, channel.id, userId))) {
      try {
        await publishChatMemberLeft(c.env, channel.id, { channelId: channel.id, userId });
      } catch (e) {
        console.error('[chat-api/chat-entity-channels] member-left publish failed:', e);
      }
      publishChannelEvent(c, 'left', channel);
    }
    return noContent(c);
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] unfollow failed:', err);
    return error.internal(c, 'Failed to unfollow entity channel');
  }
});

/**
 * GET /:entityType/:entityId/detail — provider-specific entity details.
 */
app.get('/:entityType/:entityId/detail', readPerm, async (c) => {
  const provider = getEntityProvider(c.req.param('entityType'));
  if (provider && !provider.resolveDetail) {
    return error.badRequest(c, `Provider ${provider.type} does not expose detail data`);
  }

  try {
    const access = await resolveAccess(c);
    if (access instanceof Response) return access;
    const detail = await access.provider.resolveDetail!({
      db: c.get('tenantDb'),
      actingUserId: c.get('userId'),
      entityId: access.entityId,
      can: callerCan(c),
    });
    return success(c, detail ?? null);
  } catch (err) {
    console.error('[chat-api/chat-entity-channels] fetch detail failed:', err);
    return error.internal(c, 'Failed to fetch entity detail');
  }
});

export const chatEntityChannelsRoutes = app;
