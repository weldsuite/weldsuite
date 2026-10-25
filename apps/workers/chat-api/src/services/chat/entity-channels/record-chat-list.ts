/**
 * Record chat lists: the WeldChat sidebar groups (`following`) and the record
 * chats page (`unread`, `mentions`, `all`), plus per-type counts for the group
 * headers.
 *
 * Both leave out types the caller has no permission for, and records the
 * caller cannot see or that are deleted (each provider's `filterVisible`), so a
 * deleted company's chat never lingers in a sidebar.
 */

import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  RecordChatCallerState,
  RecordChatFilter,
  RecordChatTypeSummary,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { EntityChannelProvider, PermissionCheck } from './registry';

const t = schema.chatChannels;
const m = schema.chatChannelMembers;

type ChannelRow = typeof schema.chatChannels.$inferSelect;
export type RecordChatListItem = ChannelRow & RecordChatCallerState;

const NOT_FOLLOWING: RecordChatCallerState = {
  isFollowing: false,
  isMuted: false,
  lastReadAt: null,
  lastReadMessageId: null,
  unreadMentionCount: 0,
};

/** Rounds of fetch-then-filter one page may take before it hands back a cursor. */
const MAX_SCAN_ROUNDS = 5;

/** The providers whose `requiredPermission` the caller holds. */
export async function permittedProviders(
  providers: EntityChannelProvider[],
  can: PermissionCheck,
): Promise<EntityChannelProvider[]> {
  const allowed = await Promise.all(providers.map((p) => can(p.requiredPermission)));
  return providers.filter((_, i) => allowed[i]);
}

/** Last activity, or creation for a chat that has no message yet (followed before anyone wrote). */
const activityAt = sql`coalesce(${t.lastMessageAt}, ${t.createdAt})`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The caller follows the chat, plus the filter's own condition on their membership row. */
function followCondition(userId: string, filter: Exclude<RecordChatFilter, 'all'>): SQL {
  let extra = sql``;
  if (filter === 'unread') {
    extra = sql` AND ${m.isMuted} = false AND ${t.lastMessageAt} IS NOT NULL AND (${m.lastReadAt} IS NULL OR ${t.lastMessageAt} > ${m.lastReadAt})`;
  } else if (filter === 'mentions') {
    extra = sql` AND ${m.unreadMentionCount} > 0`;
  }
  return sql`EXISTS (SELECT 1 FROM ${m} WHERE ${m.channelId} = ${t.id} AND ${m.userId} = ${userId}${extra})`;
}

/** Keep the rows whose record the caller may see, asking each type's provider once. */
async function keepVisible<R extends { entityType: string | null; entityId: string | null }>(
  rows: R[],
  providers: Map<string, EntityChannelProvider>,
  ctx: { db: Database; actingUserId: string; can: PermissionCheck },
): Promise<R[]> {
  const idsByType = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.entityType || !row.entityId) continue;
    const ids = idsByType.get(row.entityType) ?? [];
    ids.push(row.entityId);
    idsByType.set(row.entityType, ids);
  }
  const visible = new Map<string, Set<string>>();
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      const provider = providers.get(type);
      visible.set(type, provider ? await provider.filterVisible(ctx, [...new Set(ids)]) : new Set());
    }),
  );
  return rows.filter((r) => r.entityType && r.entityId && visible.get(r.entityType)?.has(r.entityId));
}

async function callerState(
  db: Database,
  userId: string,
  channelIds: string[],
): Promise<Map<string, RecordChatCallerState>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({
      channelId: m.channelId,
      isMuted: m.isMuted,
      lastReadAt: m.lastReadAt,
      lastReadMessageId: m.lastReadMessageId,
      unreadMentionCount: m.unreadMentionCount,
    })
    .from(m)
    .where(and(eq(m.userId, userId), inArray(m.channelId, channelIds)));
  return new Map(
    rows.map((r) => [
      r.channelId,
      {
        isFollowing: true,
        isMuted: r.isMuted === true,
        lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null,
        lastReadMessageId: r.lastReadMessageId ?? null,
        unreadMentionCount: r.unreadMentionCount ?? 0,
      },
    ]),
  );
}

export interface ListRecordChatsParams {
  db: Database;
  userId: string;
  can: PermissionCheck;
  /** Types to list; the caller's permission for each is checked here. */
  providers: EntityChannelProvider[];
  filter: RecordChatFilter;
  search?: string;
  cursor?: string;
  limit: number;
}

export interface ListRecordChatsResult {
  items: RecordChatListItem[];
  /**
   * Record chats matching the type, filter and search. It counts chats whose
   * record the caller can no longer see (deleted since, or out of their
   * scope), which the pages themselves never return.
   */
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

/**
 * One page of record chats, most recent activity first (`lastMessageAt desc,
 * id desc`). The cursor is the id of the last chat returned. Rows whose record
 * the caller cannot see are dropped after the fetch, so a page is filled from
 * up to {@link MAX_SCAN_ROUNDS} fetches; if it is still short, the cursor
 * points past everything scanned and `hasMore` stays true.
 */
export async function listRecordChats(params: ListRecordChatsParams): Promise<ListRecordChatsResult> {
  const { db, userId, can, filter, limit } = params;
  const providers = await permittedProviders(params.providers, can);
  if (providers.length === 0) return { items: [], totalCount: 0, hasMore: false, cursor: null };

  const conditions: SQL[] = [
    eq(t.type, 'entity'),
    isNull(t.deletedAt),
    inArray(
      t.entityType,
      providers.map((p) => p.type),
    ),
  ];
  if (filter !== 'all') conditions.push(followCondition(userId, filter));
  if (params.search) {
    conditions.push(ilike(sql`coalesce(${t.entityDisplayName}, ${t.name})`, `%${escapeLike(params.search)}%`));
  }

  const byType = new Map(providers.map((p) => [p.type, p]));
  const ctx = { db, actingUserId: userId, can };
  const page: ChannelRow[] = [];
  let after = params.cursor ?? null;
  let exhausted = false;

  for (let round = 0; round < MAX_SCAN_ROUNDS && page.length <= limit; round++) {
    const where = after
      ? and(
          ...conditions,
          sql`(${activityAt}, ${t.id}) < (SELECT coalesce(c2.last_message_at, c2.created_at), c2.id FROM ${t} c2 WHERE c2.id = ${after})`,
        )
      : and(...conditions);
    const batch = await db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(activityAt), desc(t.id))
      .limit(limit + 1);
    page.push(...(await keepVisible(batch, byType, ctx)));
    if (batch.length <= limit) {
      exhausted = true;
      break;
    }
    after = batch.at(-1)!.id;
  }

  let items = page;
  let hasMore: boolean;
  let cursor: string | null;
  if (page.length > limit) {
    items = page.slice(0, limit);
    hasMore = true;
    cursor = items.at(-1)!.id;
  } else if (exhausted) {
    hasMore = false;
    cursor = null;
  } else {
    // Out of rounds with a short page: carry on after the last row scanned.
    hasMore = true;
    cursor = after;
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(t)
    .where(and(...conditions));
  const state = await callerState(
    db,
    userId,
    items.map((r) => r.id),
  );

  return {
    items: items.map((r) => ({ ...r, ...(state.get(r.id) ?? NOT_FOLLOWING) })),
    totalCount: Number(countRow?.count ?? 0),
    hasMore,
    cursor,
  };
}

/**
 * Per type the caller may see: how many record chats they follow, how many of
 * those are unread (not muted, messages after their read marker) and how many
 * unread @mentions they hold. Every type is listed, empty ones included, in
 * provider order.
 */
export async function summarizeRecordChats(params: {
  db: Database;
  userId: string;
  can: PermissionCheck;
  providers: EntityChannelProvider[];
}): Promise<RecordChatTypeSummary[]> {
  const { db, userId, can } = params;
  const providers = await permittedProviders(params.providers, can);
  if (providers.length === 0) return [];

  const followed = await db
    .select({
      entityType: t.entityType,
      entityId: t.entityId,
      lastMessageAt: t.lastMessageAt,
      lastReadAt: m.lastReadAt,
      isMuted: m.isMuted,
      unreadMentionCount: m.unreadMentionCount,
    })
    .from(t)
    .innerJoin(m, and(eq(m.channelId, t.id), eq(m.userId, userId)))
    .where(
      and(
        eq(t.type, 'entity'),
        isNull(t.deletedAt),
        inArray(
          t.entityType,
          providers.map((p) => p.type),
        ),
      ),
    );

  const visible = await keepVisible(followed, new Map(providers.map((p) => [p.type, p])), {
    db,
    actingUserId: userId,
    can,
  });

  const summary = new Map<string, RecordChatTypeSummary>(
    providers.map((p) => [p.type, { type: p.type, label: p.label, followed: 0, unread: 0, mentions: 0 }]),
  );
  for (const row of visible) {
    const s = summary.get(row.entityType!)!;
    s.followed += 1;
    const unread =
      !row.isMuted && row.lastMessageAt !== null && (row.lastReadAt === null || row.lastMessageAt > row.lastReadAt);
    if (unread) s.unread += 1;
    s.mentions += row.unreadMentionCount ?? 0;
  }
  return [...summary.values()];
}
