import { useEffect, useMemo } from 'react';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { useRecordChats, type RecordChatListItem } from '@/hooks/queries/use-weldchat-queries';
import { coversUnread, uniqueRows } from '../lib/record-chat-groups';
import type { RecordChatType } from '../lib/record-chat-types';

/** Most pages one sidebar group loads while looking for unread chats. */
const MAX_SIDEBAR_PAGES = 4;

/**
 * The followed chats of one record type, for its sidebar group. Fetches only
 * when the caller follows some; loads further pages while the summary counts
 * unread chats or mentions the loaded rows don't hold yet.
 */
function useFollowedRecordChats(
  type: RecordChatType,
  summary: RecordChatTypeSummary | undefined,
  enabled: boolean,
): RecordChatListItem[] {
  const query = useRecordChats(type, { enabled: enabled && (summary?.followed ?? 0) > 0 });
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const rows = useMemo(() => uniqueRows(data?.pages ?? []), [data]);
  const pageCount = data?.pages.length ?? 0;

  useEffect(() => {
    if (!summary || !hasNextPage || isFetchingNextPage || pageCount >= MAX_SIDEBAR_PAGES) return;
    if (!coversUnread(rows, summary)) void fetchNextPage();
  }, [summary, rows, hasNextPage, isFetchingNextPage, pageCount, fetchNextPage]);

  return rows;
}

/**
 * Followed record chats per type for the sidebar groups. One query per type,
 * called in the fixed group order so the hooks keep their order.
 */
export function useRecordChatGroups(
  summary: readonly RecordChatTypeSummary[] | undefined,
  enabled: boolean,
): Record<RecordChatType, RecordChatListItem[]> {
  const summaryOf = (type: RecordChatType) => summary?.find((s) => s.type === type);
  return {
    company: useFollowedRecordChats('company', summaryOf('company'), enabled),
    person: useFollowedRecordChats('person', summaryOf('person'), enabled),
    task: useFollowedRecordChats('task', summaryOf('task'), enabled),
    project: useFollowedRecordChats('project', summaryOf('project'), enabled),
    domain: useFollowedRecordChats('domain', summaryOf('domain'), enabled),
    sheet: useFollowedRecordChats('sheet', summaryOf('sheet'), enabled),
    doc: useFollowedRecordChats('doc', summaryOf('doc'), enabled),
  };
}
