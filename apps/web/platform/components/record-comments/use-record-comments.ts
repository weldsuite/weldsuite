/**
 * The comment threads of a sheet or a document, from its WeldChat chat (ADR
 * CHAT-007).
 *
 * The file keeps where each thread is (a cell, a stretch of text) and
 * whether it is resolved; what is said in it is a thread in the file's
 * record chat. A thread's messages carry its id: the first one as
 * `metadata.anchor.id`, replies as ordinary thread replies to it. This hook
 * reads them, keeps them live over the chat's realtime room, and posts,
 * edits and deletes them.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecordCommentMessage } from '@weldsuite/app-api-client';
import type { RecordCommentAnchor } from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { weldchatEntityApi } from '@/lib/api/domains/weldchat-entity';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';
import { useWeldChatMessagesRealtime } from '@/hooks/weldchat/use-weldchat-messages-realtime';
import { toChatContent } from './mentions';

export type CommentRecordType = 'sheet' | 'doc';

/** What is said in one thread. */
export interface CommentThread {
  /** The thread's id in the file (\`metadata.anchor.id\`). */
  anchorId: string;
  /** The first comment, then the replies, oldest first. */
  messages: RecordCommentMessage[];
}

export const recordCommentsKey = (entityType: CommentRecordType, entityId: string) =>
  ['record-comments', entityType, entityId] as const;

function anchorIdOf(m: RecordCommentMessage): string | null {
  const anchor = m.metadata?.anchor as Partial<RecordCommentAnchor> | undefined;
  return !m.parentId && typeof anchor?.id === 'string' ? anchor.id : null;
}

/**
 * Messages grouped by thread. Two first comments for one thread (two people
 * starting a suggestion's discussion at once) make one thread.
 */
export function groupThreads(messages: readonly RecordCommentMessage[]): Map<string, CommentThread> {
  const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const threadOf = new Map<string, string>();
  for (const m of sorted) {
    const anchorId = anchorIdOf(m);
    if (anchorId) threadOf.set(m.id, anchorId);
  }
  const threads = new Map<string, CommentThread>();
  for (const m of sorted) {
    const anchorId = threadOf.get(m.id) ?? (m.parentId ? threadOf.get(m.parentId) : undefined);
    if (!anchorId) continue;
    const thread = threads.get(anchorId);
    if (thread) thread.messages.push(m);
    else threads.set(anchorId, { anchorId, messages: [m] });
  }
  return threads;
}

/**
 * `anchorIds`: the threads the file holds now. One the chat has nothing for
 * yet (someone just started it) refetches, once per change of the set.
 */
export function useRecordComments(entityType: CommentRecordType, entityId: string, anchorIds: readonly string[] = []) {
  const queryClient = useQueryClient();
  const key = useMemo(() => recordCommentsKey(entityType, entityId), [entityType, entityId]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => weldchatEntityApi.getRecordComments(entityType, entityId),
    staleTime: 30_000,
  });
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: key }), [queryClient, key]);

  const channelId = query.data?.channel?.id ?? null;
  const { client } = useWeldChatRoom(channelId);
  useWeldChatMessagesRealtime(client, channelId, {
    onMessageCreated: () => void refresh(),
    onMessageUpdated: () => void refresh(),
    onMessageDeleted: () => void refresh(),
    onGapDetected: () => void refresh(),
  });

  const threads = useMemo(() => groupThreads(query.data?.messages ?? []), [query.data]);

  const anchorsKey = [...anchorIds].sort().join(',');
  const checked = useRef('');
  useEffect(() => {
    if (!query.isSuccess || query.isFetching || checked.current === anchorsKey) return;
    checked.current = anchorsKey;
    if (anchorIds.some((id) => !threads.has(id))) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorsKey, query.isSuccess, query.isFetching]);

  /** Starts a thread: its first comment, with where it is. */
  const start = useCallback(
    async (anchor: RecordCommentAnchor, body: string) => {
      const { content, mentions } = toChatContent(body);
      await weldchatEntityApi.sendEntityMessage(entityType, entityId, { content, mentions, metadata: { anchor } });
      await refresh();
    },
    [entityType, entityId, refresh],
  );

  /** Replies in a thread; the first message of a thread nobody wrote in yet (a suggestion's) starts it. */
  const reply = useCallback(
    async (anchor: RecordCommentAnchor, body: string) => {
      const first = threads.get(anchor.id)?.messages.find((m) => !m.parentId);
      if (!first) return start(anchor, body);
      const { content, mentions } = toChatContent(body);
      await weldchatEntityApi.sendEntityMessage(entityType, entityId, { content, mentions, parentId: first.id });
      await refresh();
    },
    [threads, start, entityType, entityId, refresh],
  );

  const edit = useCallback(
    async (messageId: string, body: string) => {
      await weldchatEntityApi.editMessage(messageId, toChatContent(body).content);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (messageIds: readonly string[]) => {
      for (const id of messageIds) await weldchatEntityApi.deleteMessage(id);
      await refresh();
    },
    [refresh],
  );

  return {
    threads,
    channelId,
    isLoading: query.isLoading,
    isError: query.isError,
    start,
    reply,
    edit,
    remove,
  };
}

export type RecordCommentsState = ReturnType<typeof useRecordComments>;
