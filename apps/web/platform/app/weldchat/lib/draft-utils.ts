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

interface DmMemberLike {
  userId: string;
  name?: string | null;
}

/** A `/chat-dm` row, reduced to what naming the conversation needs. */
export interface DmChannelLike {
  id: string;
  members?: ReadonlyArray<DmMemberLike> | null;
  otherMembers?: ReadonlyArray<DmMemberLike> | null;
}

/**
 * The name a DM goes by in lists: the other people in it, or your own name for
 * the DM with yourself. Null when no name is known.
 */
export function dmDisplayName(dm: DmChannelLike): string | null {
  const others = (dm.otherMembers ?? []).map((m) => m.name?.trim()).filter(Boolean);
  if (others.length > 0) return others.join(', ');
  const self = dm.members?.[0]?.name?.trim();
  return self || null;
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
