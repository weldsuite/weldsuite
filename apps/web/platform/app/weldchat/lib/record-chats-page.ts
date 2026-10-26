/**
 * The record chats page (`/weldchat/records`): which type tab and filter the
 * URL asks for, which tabs the caller gets, and the copy of each empty list.
 * Pure, so the rules are tested without the page.
 */

import {
  RECORD_CHAT_FILTERS,
  type RecordChatFilter,
  type RecordChatTypeSummary,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { isRecordChatType, RECORD_CHAT_TYPES, type RecordChatType } from './record-chat-types';

export { RECORD_CHAT_FILTERS, type RecordChatFilter };

/** The page's search params. Both are left out at their default (all types, following). */
export interface RecordChatsSearch {
  type?: RecordChatType;
  filter?: RecordChatFilter;
}

export const DEFAULT_RECORD_CHAT_FILTER: RecordChatFilter = 'following';

function isRecordChatFilter(value: unknown): value is RecordChatFilter {
  return typeof value === 'string' && (RECORD_CHAT_FILTERS as readonly string[]).includes(value);
}

/** `validateSearch` of the route: unknown types and filters are dropped, not an error. */
export function parseRecordChatsSearch(search: Record<string, unknown>): RecordChatsSearch {
  const type = typeof search.type === 'string' && isRecordChatType(search.type) ? search.type : undefined;
  const filter =
    isRecordChatFilter(search.filter) && search.filter !== DEFAULT_RECORD_CHAT_FILTER ? search.filter : undefined;
  return { ...(type && { type }), ...(filter && { filter }) };
}

/**
 * The record types the caller may list, in tab order. The summary has one row
 * per type the caller has the permission for, so a type without one gets no
 * tab, the same as it gets no sidebar group. Null while the summary is unknown.
 */
export function permittedRecordChatTypes(
  summary: readonly RecordChatTypeSummary[] | undefined,
): RecordChatType[] | null {
  if (!summary) return null;
  const listed = new Set(summary.map((s) => s.type));
  return RECORD_CHAT_TYPES.filter((type) => listed.has(type));
}

/**
 * The type tab to show. A type the caller has no permission for falls back to
 * All; while the permitted types are unknown the asked-for type is kept, so a
 * "Show all" link does not flash the All tab first.
 */
export function resolveRecordChatsType(
  requested: RecordChatType | undefined,
  permitted: readonly RecordChatType[] | null,
): RecordChatType | undefined {
  if (!requested) return undefined;
  if (permitted && !permitted.includes(requested)) return undefined;
  return requested;
}

const K = 'sweep.weldchat.recordChats.page';

/** i18n key of each filter's label. */
export const RECORD_CHAT_FILTER_LABEL_KEYS: Record<RecordChatFilter, string> = {
  following: `${K}.filters.following`,
  unread: `${K}.filters.unread`,
  mentions: `${K}.filters.mentions`,
  all: `${K}.filters.all`,
};

/** i18n keys of the empty list under a filter, before any search. */
export function recordChatsEmptyKeys(filter: RecordChatFilter): { title: string; description: string } {
  return { title: `${K}.empty.${filter}.title`, description: `${K}.empty.${filter}.description` };
}
