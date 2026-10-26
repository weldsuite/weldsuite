/**
 * Home's record chats: the per-type summary and the followed chats of each
 * type, painted from the offline cache first like the channel list, then
 * loaded from the network. `refresh` coalesces bursts (a busy chat sends an
 * event per message) into one load; `patch` shows a menu action at once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordChatListItem } from '@weldsuite/app-api-client/domains/chat-entity-channels';
import type { RecordChatTypeSummary } from '@weldsuite/app-api-client/schemas/chat-entity-channels';

import { useChatCache } from '@/hooks/useChatCache';
import {
  MAX_GROUP_PAGES,
  RECORD_CHAT_TYPES,
  changedSummaryTypes,
  coversUnread,
  patchRecordChats,
  uniqueRows,
  type RecordChatPatch,
  type RecordChatType,
  type RecordChatsSnapshot,
} from '@/lib/record-chats/rules';
import { appApi } from '@/services/app-api';

/** Rows per request: the 5 a group shows plus room for quiet chats in between. */
const PAGE_SIZE = 25;
/** Events in a burst wait this long, then load once. */
const REFRESH_DEBOUNCE_MS = 400;

type Snapshot = RecordChatsSnapshot<RecordChatListItem>;
export type RecordRefresh = 'all' | 'summary';

const EMPTY: Snapshot = { summary: null, rows: {} };

function isSnapshot(value: unknown): value is Snapshot {
  return !!value && typeof value === 'object' && 'summary' in value && 'rows' in value;
}

/**
 * The followed chats of one type, newest activity first. Loads further pages
 * while the summary counts unread chats or mentions the rows don't hold yet,
 * so a collapsed group can still show an unread chat older than page one.
 */
async function loadFollowed(type: RecordChatType, counts: RecordChatTypeSummary): Promise<RecordChatListItem[]> {
  const pages: RecordChatListItem[][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_GROUP_PAGES; page++) {
    const res = await appApi.chatEntityChannels.list({ type, filter: 'following', limit: PAGE_SIZE, cursor });
    pages.push(res.data ?? []);
    const next = res.pagination?.hasMore ? res.pagination.cursor : null;
    if (!next || coversUnread(uniqueRows(pages), counts)) break;
    cursor = next;
  }
  return uniqueRows(pages);
}

export function useRecordChatGroups() {
  const cache = useChatCache();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const snapshotRef = useRef(snapshot);
  // Bumped on a workspace switch, so a load for the previous workspace that
  // lands late is dropped.
  const generationRef = useRef(0);
  const networkLoadedRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    networkLoadedRef.current = false;
    snapshotRef.current = EMPTY;
    setSnapshot(EMPTY);
    void cache.getRecordChats().then((cached) => {
      if (generation !== generationRef.current || networkLoadedRef.current || !isSnapshot(cached)) return;
      snapshotRef.current = cached;
      setSnapshot(cached);
    });
  }, [cache]);

  const commit = useCallback(
    (next: Snapshot) => {
      networkLoadedRef.current = true;
      snapshotRef.current = next;
      setSnapshot(next);
      void cache.setRecordChats(next);
    },
    [cache],
  );

  /** `all`: the summary and every followed type. `summary`: the summary, then only the types whose counts moved. */
  const load = useCallback(
    async (kind: RecordRefresh) => {
      const generation = generationRef.current;
      const res = await appApi.chatEntityChannels.summary();
      const summary = res.data ?? [];
      const types = kind === 'all' ? RECORD_CHAT_TYPES : changedSummaryTypes(snapshotRef.current.summary, summary);
      const loaded = await Promise.all(
        types.map(async (type) => {
          const counts = summary.find((s) => s.type === type);
          return [type, counts && counts.followed > 0 ? await loadFollowed(type, counts) : []] as const;
        }),
      );
      if (generation !== generationRef.current) return;
      commit({ summary, rows: { ...snapshotRef.current.rows, ...Object.fromEntries(loaded) } });
    },
    [commit],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const pendingRef = useRef<RecordRefresh | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const flush = useCallback(async () => {
    timerRef.current = null;
    if (runningRef.current) {
      // One load at a time; this one runs when the current one is done.
      timerRef.current = setTimeout(() => void flush(), REFRESH_DEBOUNCE_MS);
      return;
    }
    const kind = pendingRef.current;
    pendingRef.current = null;
    if (!kind) return;
    runningRef.current = true;
    try {
      await loadRef.current(kind);
    } catch (err) {
      // Keep the cached / previously loaded groups instead of clearing them.
      console.error('Failed to load record chats:', err);
    } finally {
      runningRef.current = false;
    }
  }, []);

  /** Reload the groups; `immediate` skips the burst wait (screen focus). */
  const refresh = useCallback(
    (kind: RecordRefresh, immediate = false) => {
      pendingRef.current = pendingRef.current === 'all' ? 'all' : kind;
      if (immediate && !runningRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        void flush();
      } else if (!timerRef.current) {
        timerRef.current = setTimeout(() => void flush(), REFRESH_DEBOUNCE_MS);
      }
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** Show a menu action (mute, mark read, unfollow) before the server confirms it. */
  const patch = useCallback(
    (id: string, change: RecordChatPatch) => commit(patchRecordChats(snapshotRef.current, id, change)),
    [commit],
  );

  return { summary: snapshot.summary, rows: snapshot.rows, refresh, patch };
}
