/**
 * useDraftAutosave — persists message-input content to the draft API.
 *
 * Usage:
 *   const { draftId, deleteDraft } = useDraftAutosave({
 *     channelId,
 *     threadParentMessageId: parentId,
 *     content,
 *     attachments,
 *     onRestore,
 *   });
 *
 * - Once the drafts have loaded, if a draft exists for this context and the
 *   editor is empty, calls onRestore(). That happens once per context
 *   (channel + thread parent), and only for a draft that existed then: never
 *   for one this composer created or deleted itself.
 * - While mounted, debounces content+attachments changes (500ms) and calls upsert.
 *   An empty composer never creates a draft; it only deletes one that exists.
 * - When the composer unmounts, or moves to another channel/thread without
 *   unmounting, flushes any unsent text to the context it was typed in.
 * - `deleteDraft()` ends with no draft for this composer: it cancels the pending
 *   debounce and waits for any save already in flight before deleting, so a
 *   late-landing create can't resurrect a draft after send.
 *
 * Saves and deletes run one at a time (a promise chain), so they land in the
 * order they were requested.
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  useChatDrafts,
  useUpsertDraft,
  useDeleteDraft,
} from '@/hooks/queries/use-weldchat-extras-queries';
import type { DraftItem, ChatAttachmentInput } from '@weldsuite/core-api-client/schemas/weldchat-drafts';

export interface DraftAutosaveOptions {
  channelId: string;
  threadParentMessageId?: string;
  /** Plain-text content from the editor (what would be sent). */
  content: string;
  attachments?: ChatAttachmentInput[];
  /** Called with the restored content + attachments when a draft is found on mount. */
  onRestore?: (content: string, attachments: ChatAttachmentInput[]) => void;
}

export interface DraftAutosaveResult {
  /** ID of the current persisted draft (if any). */
  draftId: string | null;
  /** Imperatively delete the draft (call after successful send). */
  deleteDraft: () => void;
}

const DEBOUNCE_MS = 500;

const hasDraftContent = (content: string, attachments: ChatAttachmentInput[]) =>
  content.trim().length > 0 || attachments.length > 0;

const contextKey = (channelId: string, threadParentMessageId?: string) =>
  `${channelId}|${threadParentMessageId ?? ''}`;

export function useDraftAutosave({
  channelId,
  threadParentMessageId,
  content,
  attachments = [],
  onRestore,
}: DraftAutosaveOptions): DraftAutosaveResult {
  const { data: draftsData } = useChatDrafts();
  const { mutateAsync: upsertAsync } = useUpsertDraft();
  const { mutateAsync: deleteAsync } = useDeleteDraft();

  const drafts: DraftItem[] = draftsData?.data ?? [];

  // Find the matching draft for this context.
  const matchingDraft = drafts.find(
    (d) =>
      d.channelId === channelId &&
      (d.threadParentMessageId ?? null) === (threadParentMessageId ?? null),
  ) ?? null;

  const ctxKey = contextKey(channelId, threadParentMessageId);
  const ctxKeyRef = useRef(ctxKey);

  // The draft id we created or saw most recently. Kept separately from the
  // query cache, which lags behind a save we just made.
  const knownIdRef = useRef<string | null>(null);
  // Ids deleted by this composer: the cache may still list them for a moment.
  const deletedIdsRef = useRef(new Set<string>());
  // Set once the drafts of the current context have been looked at for a restore.
  const resolvedRef = useRef(false);
  // Bumped by deleteDraft (and on a context change) so a save that was already
  // queued behind another operation is dropped instead of re-creating a draft.
  const generationRef = useRef(0);

  // The composer isn't necessarily remounted when the channel/thread changes:
  // forget everything that belonged to the previous context.
  if (ctxKeyRef.current !== ctxKey) {
    ctxKeyRef.current = ctxKey;
    knownIdRef.current = null;
    deletedIdsRef.current = new Set();
    resolvedRef.current = false;
    generationRef.current += 1;
  }

  if (matchingDraft && !deletedIdsRef.current.has(matchingDraft.id)) {
    knownIdRef.current = matchingDraft.id;
  }

  const contentRef = useRef(content);
  contentRef.current = content;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((op: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(op).catch(() => undefined);
  }, []);

  const save = useCallback(
    (
      target: { channelId: string; threadParentMessageId?: string },
      text: string,
      files: ChatAttachmentInput[],
    ) => {
      const generation = generationRef.current;
      const key = contextKey(target.channelId, target.threadParentMessageId);
      enqueue(async () => {
        if (generation !== generationRef.current) return;
        const res = await upsertAsync({
          channelId: target.channelId,
          threadParentMessageId: target.threadParentMessageId ?? undefined,
          content: text,
          attachments: files.length > 0 ? files : undefined,
        });
        const id = res?.data?.id;
        // A save for a context we have since left must not become this one's draft.
        if (id && key === ctxKeyRef.current) {
          knownIdRef.current = id;
          deletedIdsRef.current.delete(id);
        }
      });
    },
    [enqueue, upsertAsync],
  );

  const removeDraft = useCallback(() => {
    generationRef.current += 1;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const key = ctxKeyRef.current;
    enqueue(async () => {
      // Runs after any save that was in flight, so `knownIdRef` already holds
      // the id that save created.
      if (key !== ctxKeyRef.current) return;
      const id = knownIdRef.current;
      if (!id) return;
      knownIdRef.current = null;
      deletedIdsRef.current.add(id);
      await deleteAsync(id);
    });
  }, [enqueue, deleteAsync]);

  // Restore once the drafts have loaded for this context.
  useEffect(() => {
    if (resolvedRef.current || !draftsData) return;
    resolvedRef.current = true;
    if (!matchingDraft) return;
    if (content.trim().length > 0) return; // Don't overwrite user typing
    onRestore?.(matchingDraft.content, matchingDraft.attachments ?? []);
  // Only when the drafts (re)load for a context; later list changes never restore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftsData, ctxKey]);

  // Debounced save on content / attachments change.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(() => {
      if (hasDraftContent(content, attachments)) {
        save({ channelId, threadParentMessageId }, content, attachments);
      } else if (knownIdRef.current) {
        // The user emptied the composer: drop the draft that exists, never write an empty one.
        removeDraft();
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  // We intentionally re-run on every content/attachments change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, attachments]);

  // On unmount, or when the channel/thread changes under a mounted composer:
  // flush unsent text to the context it was typed in (fire-and-forget).
  useEffect(() => {
    const target = { channelId, threadParentMessageId };
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      // Only save if there is content to persist.
      if (hasDraftContent(contentRef.current, attachmentsRef.current)) {
        save(target, contentRef.current, attachmentsRef.current);
      }
    };
  }, [channelId, threadParentMessageId, save]);

  const deleteDraft = useCallback(() => {
    removeDraft();
  }, [removeDraft]);

  return {
    draftId: knownIdRef.current,
    deleteDraft,
  };
}
