/**
 * Record chats on the Home tab: which groups show, which chats each group
 * lists, and when the groups need reloading. Pure, so the rules are tested
 * without the screen.
 *
 * Same rules as the platform sidebar (apps/web/platform/app/weldchat/lib/
 * record-chat-groups.ts + group-filter.ts with RECORD_GROUP_FILTER): one group
 * per record type the user follows, in a fixed order, the 5 most recent chats
 * with mentions and unread chats first, quiet chats left out, and only unread
 * chats and mentions under a collapsed group.
 */

import {
  RECORD_CHAT_TYPES,
  type RecordChatType,
  type RecordChatTypeSummary,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';

export { RECORD_CHAT_TYPES, type RecordChatType };

/** Chats a group shows at most before its "Show all (N)" row. */
export const RECORD_GROUP_TOP_N = 5;

/** A chat with no message for this long, and nothing unread, is quiet. */
export const QUIET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Most pages a group loads while looking for the unread chats the summary counts. */
export const MAX_GROUP_PAGES = 4;

/** The fields of a record chat row these rules read. */
export interface RecordChatState {
  id: string;
  isMuted?: boolean | null;
  lastMessageAt?: string | null;
  lastReadAt?: string | null;
  unreadMentionCount?: number | null;
}

function time(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

export function isRecordChatType(type: string | null | undefined): type is RecordChatType {
  return !!type && (RECORD_CHAT_TYPES as readonly string[]).includes(type);
}

/** A record chat's name: the record's display name, else the channel name. */
export function recordChatName(chat: { entityDisplayName?: string | null; name?: string | null }): string {
  return chat.entityDisplayName || chat.name || '';
}

/** Messages after the read marker, muted or not (sort boost, collapsed peek). */
export function hasUnreadMessages(row: RecordChatState): boolean {
  if (!row.lastMessageAt) return false;
  if (!row.lastReadAt) return true;
  return time(row.lastMessageAt) > time(row.lastReadAt);
}

/** Same rule as the server's `unread` filter and summary count: not muted, with messages after the read marker. */
export function isUnreadRecordChat(row: RecordChatState): boolean {
  return !row.isMuted && hasUnreadMessages(row);
}

export function hasUnreadMentions(row: RecordChatState): boolean {
  return (row.unreadMentionCount ?? 0) > 0;
}

/** Unread mentions, or unread messages that are not muted. Such a chat is never quiet. */
export function needsAttention(row: RecordChatState): boolean {
  return hasUnreadMentions(row) || isUnreadRecordChat(row);
}

/**
 * No message in 30 days (or none at all) and nothing asking for attention:
 * left out of the Home groups, still on the records screen, back as soon as
 * someone writes.
 */
export function isQuietRecordChat(row: RecordChatState, now: number): boolean {
  if (needsAttention(row)) return false;
  if (!row.lastMessageAt) return true;
  return now - time(row.lastMessageAt) > QUIET_AFTER_MS;
}

function tier(row: RecordChatState): number {
  if (hasUnreadMentions(row)) return 0;
  if (hasUnreadMessages(row)) return 1;
  return 2;
}

/** Mentions first, then unread chats, then the rest; most recent message first within each. */
export function sortRecordChats<T extends RecordChatState>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => tier(a) - tier(b) || time(b.lastMessageAt) - time(a.lastMessageAt));
}

export interface RecordGroup<T extends RecordChatState> {
  type: RecordChatType;
  /** What the group lists: the top chats, or under a collapsed header only the unread ones. */
  rows: T[];
  followed: number;
  unread: number;
  mentions: number;
  collapsed: boolean;
  /** Add a "Show all (N)" row: the group lists fewer chats than the user follows. */
  showAll: boolean;
}

export interface RecordGroupOptions {
  isCollapsed?: (type: RecordChatType) => boolean;
  now?: number;
  topN?: number;
}

/**
 * The Home tab's record chat groups, in the fixed order company, person, task,
 * project, domain. A type gets a group when the user follows chats of it and
 * at least one of them is not quiet.
 */
export function buildRecordGroups<T extends RecordChatState>(
  summary: readonly RecordChatTypeSummary[] | null | undefined,
  rowsByType: Partial<Record<RecordChatType, readonly T[]>>,
  options: RecordGroupOptions = {},
): RecordGroup<T>[] {
  const now = options.now ?? Date.now();
  const topN = options.topN ?? RECORD_GROUP_TOP_N;
  const groups: RecordGroup<T>[] = [];

  for (const type of RECORD_CHAT_TYPES) {
    const counts = summary?.find((s) => s.type === type);
    if (!counts || counts.followed <= 0) continue;

    const listed = sortRecordChats(
      (rowsByType[type] ?? []).filter((row) => !isQuietRecordChat(row, now)),
    ).slice(0, topN);
    if (listed.length === 0) continue;

    const collapsed = options.isCollapsed?.(type) ?? false;
    groups.push({
      type,
      rows: collapsed
        ? listed.filter((row) => hasUnreadMentions(row) || hasUnreadMessages(row))
        : listed,
      followed: counts.followed,
      unread: counts.unread,
      mentions: counts.mentions,
      collapsed,
      showAll: !collapsed && counts.followed > listed.length,
    });
  }
  return groups;
}

/**
 * Whether the loaded rows hold every unread chat and mention the summary
 * counts. When not, the group loads another page, so it can still show an
 * unread chat that is older than the first page.
 */
export function coversUnread(rows: readonly RecordChatState[], summary: RecordChatTypeSummary): boolean {
  let unread = 0;
  let mentions = 0;
  for (const row of rows) {
    if (isUnreadRecordChat(row)) unread++;
    mentions += row.unreadMentionCount ?? 0;
  }
  return unread >= summary.unread && mentions >= summary.mentions;
}

/** Rows of several pages, each chat once (a chat can move between pages as messages arrive). */
export function uniqueRows<T extends { id: string }>(pages: readonly (readonly T[])[]): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const row of page) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** What Home keeps of the record chats: the summary and the loaded followed chats per type. */
export interface RecordChatsSnapshot<T extends RecordChatState & { entityType: string }> {
  summary: RecordChatTypeSummary[] | null;
  rows: Partial<Record<RecordChatType, T[]>>;
}

/** A change made from a row's menu, shown before the server confirms it. */
export interface RecordChatPatch {
  isMuted?: boolean;
  /** `false`: read up to now. */
  hasUnread?: false;
  /** `false`: unfollowed, so the chat leaves Home. */
  isFollowing?: false;
}

/**
 * The snapshot with one chat changed, its type's summary counts moved with
 * it, so the group header and "Show all (N)" stay right until the next load.
 */
export function patchRecordChats<T extends RecordChatState & { entityType: string }>(
  snapshot: RecordChatsSnapshot<T>,
  id: string,
  patch: RecordChatPatch,
  now: number = Date.now(),
): RecordChatsSnapshot<T> {
  const type = RECORD_CHAT_TYPES.find((ty) => snapshot.rows[ty]?.some((row) => row.id === id));
  if (!type) return snapshot;
  const rows = snapshot.rows[type] ?? [];
  const before = rows.find((row) => row.id === id)!;

  let after: T | null = { ...before };
  if (patch.isMuted !== undefined) after.isMuted = patch.isMuted;
  if (patch.hasUnread === false) {
    after.lastReadAt = new Date(now).toISOString();
    after.unreadMentionCount = 0;
  }
  if (patch.isFollowing === false) after = null;

  const count = (row: T | null) => ({
    followed: row ? 1 : 0,
    unread: row && isUnreadRecordChat(row) ? 1 : 0,
    mentions: row?.unreadMentionCount ?? 0,
  });
  const a = count(before);
  const b = count(after);
  const summary =
    snapshot.summary?.map((s) =>
      s.type === type
        ? {
            ...s,
            followed: Math.max(0, s.followed - a.followed + b.followed),
            unread: Math.max(0, s.unread - a.unread + b.unread),
            mentions: Math.max(0, s.mentions - a.mentions + b.mentions),
          }
        : s,
    ) ?? null;

  return {
    summary,
    rows: {
      ...snapshot.rows,
      [type]: after ? rows.map((row) => (row.id === id ? after : row)) : rows.filter((row) => row.id !== id),
    },
  };
}

/** Record types whose followed, unread or mention counts differ between two summaries. */
export function changedSummaryTypes(
  previous: readonly RecordChatTypeSummary[] | null | undefined,
  next: readonly RecordChatTypeSummary[],
): RecordChatType[] {
  const before = new Map((previous ?? []).map((s) => [s.type, s]));
  return RECORD_CHAT_TYPES.filter((type) => {
    const a = before.get(type);
    const b = next.find((s) => s.type === type);
    if (!a || !b) return a !== b;
    return a.followed !== b.followed || a.unread !== b.unread || a.mentions !== b.mentions;
  });
}

/**
 * What a realtime event on the user's topics means for the record chat groups:
 * reload the groups (`all`), only the summary, which then reloads the types
 * whose counts changed (`summary`), or nothing.
 *
 * `channel_new` is sent to every new follower. `unread_update` and `mention`
 * come for every message in a followed chat: a known record chat reloads its
 * groups, a known channel has nothing to do with them, and an unknown one (a
 * DM, or a record chat the groups have not loaded) costs one summary request.
 */
export function recordRefreshFor(
  event: { event?: string; data?: unknown } | undefined,
  known: { recordChatIds: ReadonlySet<string>; channelIds: ReadonlySet<string> },
): 'all' | 'summary' | 'none' {
  if (!event?.event) return 'summary';
  if (event.event === 'channel_new') return 'all';
  if (event.event === 'dm_new') return 'none';
  const data = event.data as { channelId?: unknown } | null | undefined;
  const channelId = typeof data?.channelId === 'string' ? data.channelId : null;
  if (channelId && known.recordChatIds.has(channelId)) return 'all';
  if (channelId && known.channelIds.has(channelId)) return 'none';
  return 'summary';
}
