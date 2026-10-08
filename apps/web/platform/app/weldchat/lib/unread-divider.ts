/**
 * The "New messages" line: drawn above the first message that arrived after
 * the caller last read the channel, as it stood when they opened it.
 *
 * Opening a channel marks it read; that call answers with where the caller had
 * read up to before (`since`) and the new read position (`until`). Messages in
 * between were unread on arrival. Messages posted while the channel is open
 * come after `until` and never get the line.
 */

export interface UnreadMarker {
  channelId: string;
  /** Read position before the channel was opened. */
  since: string;
  /** Read position the open moved it to. */
  until: string;
}

/** What one mark-read call answered: `since` is null when the caller had never read the channel. */
export interface MarkReadAnswer {
  channelId: string;
  since: string | null;
  until: string;
}

const time = (iso: string): number => Date.parse(iso);

/**
 * Folds a mark-read answer into the marker for the channel being shown. The
 * open can run more than once (React StrictMode runs effects twice in dev),
 * and a later call sees the earlier call's read position, so keep the earliest
 * `since` and the latest `until`. A member who had never read the channel gets
 * no line: everything would be "new".
 */
export function mergeUnreadMarker(
  current: UnreadMarker | null | undefined,
  shownChannelId: string,
  answer: MarkReadAnswer,
): UnreadMarker | null | undefined {
  if (answer.channelId !== shownChannelId) return current;
  if (answer.since === null || current === null) return null;
  if (current?.channelId !== shownChannelId) {
    return { channelId: shownChannelId, since: answer.since, until: answer.until };
  }
  return {
    channelId: shownChannelId,
    since: time(answer.since) < time(current.since) ? answer.since : current.since,
    until: time(answer.until) > time(current.until) ? answer.until : current.until,
  };
}

interface MessageLike {
  id: string;
  createdAt?: string | null;
  authorId?: string | null;
}

/**
 * The first message (in chronological order) that was unread when the channel
 * opened, or null. Your own messages are never new to you.
 */
export function firstUnreadMessageId(
  messages: ReadonlyArray<MessageLike>,
  marker: Pick<UnreadMarker, 'since' | 'until'> | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!marker) return null;
  const since = time(marker.since);
  const until = time(marker.until);
  if (Number.isNaN(since) || Number.isNaN(until)) return null;
  for (const message of messages) {
    const at = time(message.createdAt ?? '');
    if (Number.isNaN(at) || at <= since || at > until) continue;
    if (currentUserId && message.authorId === currentUserId) continue;
    return message.id;
  }
  return null;
}
