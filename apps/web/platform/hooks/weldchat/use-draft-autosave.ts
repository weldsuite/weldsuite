/**
 * useDraftAutosave — persists message-input content to the draft API.
 *
 * Usage:
 *   const { draftId, restoredContent, restoredAttachments } = useDraftAutosave({
 *     channelId,
 *     threadParentMessageId: parentId,
 *     content,
 *     attachments,
 *     onRestore,
 *   });
 *
 * - On mount, if a matching draft exists and the editor is empty, calls onRestore().
 * - While mounted, debounces content+attachments changes (500ms) and calls upsert.
 * - On unmount, flushes any pending save synchronously (fire-and-forget).
 * - Provides `deleteDraft(draftId)` for callers to clear the draft after send.
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  useChatDrafts,
  useUpsertDraft,
  useDeleteDraft,
} from '@/hooks/queries/use-weldchat-extras-queries';
import type { DraftItem } from '@weldsuite/core-api-client/schemas/weldchat-drafts';

export interface DraftAutosaveOptions {
  channelId: string;
  threadParentMessageId?: string;
  /** Plain-text content from the editor (what would be sent). */
  content: string;
  attachments?: any[];
  /** Called with the restored content + attachments when a draft is found on mount. */
  onRestore?: (content: string, attachments: any[]) => void;
}

export interface DraftAutosaveResult {
  /** ID of the current persisted draft (if any). */
  draftId: string | null;
  /** Imperatively delete the draft (call after successful send). */
  deleteDraft: () => void;
}

const DEBOUNCE_MS = 500;

export function useDraftAutosave({
  channelId,
  threadParentMessageId,
  content,
  attachments = [],
  onRestore,
}: DraftAutosaveOptions): DraftAutosaveResult {
  const { data: draftsData } = useChatDrafts();
  const { mutate: upsert } = useUpsertDraft();
  const { mutate: deleteDraftMutate } = useDeleteDraft();

  const drafts: DraftItem[] = (draftsData as any)?.data ?? [];

  // Find the matching draft for this context.
  const matchingDraft = drafts.find(
    (d) =>
      d.channelId === channelId &&
      (d.threadParentMessageId ?? null) === (threadParentMessageId ?? null),
  ) ?? null;

  const draftIdRef = useRef<string | null>(matchingDraft?.id ?? null);
  draftIdRef.current = matchingDraft?.id ?? null;

  const restoredRef = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: restore draft if editor is empty and a draft exists.
  useEffect(() => {
    if (restoredRef.current) return;
    if (!matchingDraft) return;
    if (content.trim().length > 0) return; // Don't overwrite user typing
    restoredRef.current = true;
    onRestore?.(matchingDraft.content, matchingDraft.attachments ?? []);
  // Only run once — when drafts load and content is still empty.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingDraft?.id]);

  // Debounced save on content / attachments change.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(() => {
      upsert({
        channelId,
        threadParentMessageId: threadParentMessageId ?? undefined,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  // We intentionally re-run on every content/attachments change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, attachments]);

  // On unmount: flush any pending save (fire-and-forget).
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      const pending = contentRef.current;
      const pendingAttachments = attachmentsRef.current;
      // Only save if there is content to persist.
      if (pending.trim().length > 0 || pendingAttachments.length > 0) {
        upsert({
          channelId,
          threadParentMessageId: threadParentMessageId ?? undefined,
          content: pending,
          attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
        });
      }
    };
  // Intentionally empty dep array — cleanup runs once on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteDraft = useCallback(() => {
    const id = draftIdRef.current;
    if (id) {
      deleteDraftMutate(id);
      draftIdRef.current = null;
    } else {
      // Draft may have been deleted already or not yet persisted; upsert with
      // empty content which the backend will treat as a delete.
      upsert({
        channelId,
        threadParentMessageId: threadParentMessageId ?? undefined,
        content: '',
      });
    }
  }, [channelId, threadParentMessageId, deleteDraftMutate, upsert]);

  return {
    draftId: draftIdRef.current,
    deleteDraft,
  };
}
