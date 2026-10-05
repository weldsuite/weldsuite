/** Shape of a saved draft that matters for deciding whether it is worth listing. */
interface DraftContentLike {
  content?: string | null;
  attachments?: ReadonlyArray<unknown> | null;
}

/**
 * A draft is only "left behind" work if it has text or attachments. The composer
 * can leave an emptied draft row behind (typed, then cleared); listing it shows
 * a "No content" row and inflates the Drafts badge.
 */
export function hasDraftContent(draft: DraftContentLike): boolean {
  return !!draft.content?.trim() || (draft.attachments?.length ?? 0) > 0;
}

interface DraftTarget {
  channelId?: string | null;
  threadParentMessageId?: string | null;
}

export type DraftDestination =
  | { kind: 'thread'; channelId: string; messageId: string }
  | { kind: 'channel'; channelId: string }
  | null;

/**
 * Where "continue writing" should go: a thread draft reopens its thread (whose
 * composer restores the draft on mount), anything else opens the channel / DM.
 */
export function getDraftDestination(draft: DraftTarget): DraftDestination {
  if (!draft.channelId) return null;
  if (draft.threadParentMessageId) {
    return { kind: 'thread', channelId: draft.channelId, messageId: draft.threadParentMessageId };
  }
  return { kind: 'channel', channelId: draft.channelId };
}
