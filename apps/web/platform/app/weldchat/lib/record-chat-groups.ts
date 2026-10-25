/**
 * Which record chat groups the WeldChat sidebar shows, and when a group needs
 * its "Show all" row. Pure, so the rules are tested without the sidebar hook.
 */

import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { RECORD_CHAT_TYPES, recordGroupKey, type RecordChatType } from './record-chat-types';

/** The fields of a record chat row these rules read. */
interface RecordChatState {
  id: string;
  isMuted?: boolean | null;
  lastMessageAt?: string | null;
  lastReadAt?: string | null;
  unreadMentionCount?: number | null;
}

/**
 * Record types that get a sidebar group, in the fixed group order (company,
 * person, task, project, domain): the caller follows at least one chat of the
 * type and has not hidden the group.
 */
export function recordGroupTypes(
  summary: readonly RecordChatTypeSummary[] | undefined,
  isHidden: (groupKey: string) => boolean,
): RecordChatType[] {
  const followed = new Map((summary ?? []).map((s) => [s.type, s.followed]));
  return RECORD_CHAT_TYPES.filter(
    (type) => (followed.get(type) ?? 0) > 0 && !isHidden(recordGroupKey(type)),
  );
}

/**
 * A group gets a "Show all (N)" row when it shows fewer chats than the caller
 * follows: cut off by top-N, or quiet chats left out. Not under a collapsed
 * group, which only peeks at unread chats.
 */
export function needsShowAll(shownCount: number, followed: number, collapsed: boolean): boolean {
  return !collapsed && followed > shownCount;
}

/** Same rule as the server's `unread` filter: not muted, with messages after the read marker. */
export function isUnreadRecordChat(row: RecordChatState): boolean {
  if (row.isMuted || !row.lastMessageAt) return false;
  return !row.lastReadAt || new Date(row.lastMessageAt).getTime() > new Date(row.lastReadAt).getTime();
}

/**
 * Whether the loaded rows hold every unread chat and mention the summary
 * counts. When not, the sidebar loads another page, so a collapsed group can
 * still peek at an unread chat that is older than the first page.
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

/** Rows of every loaded page, each chat once (a chat can move between pages as messages arrive). */
export function uniqueRows<T extends { id: string }>(pages: ReadonlyArray<{ data?: T[] } | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const row of page?.data ?? []) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}
