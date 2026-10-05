/**
 * A thread is only valid in the channel it was opened in. The layout stores the
 * open thread together with that channel and derives everything from it, so a
 * channel switch can never carry a thread (and its parent message) along.
 */
export interface OpenThread {
  channelId: string;
  messageId: string;
}

/** The thread to show for `activeChannelId`, or null when none is open there. */
export function threadMessageIdFor(thread: OpenThread | null, activeChannelId: string): string | null {
  return thread && thread.channelId === activeChannelId ? thread.messageId : null;
}

/**
 * State update for "the active channel changed": drop a thread that belongs to
 * another channel, keep one that belongs to the new channel (e.g. a jump link
 * that opened its thread in the same commit as the navigation).
 */
export function threadAfterChannelChange(thread: OpenThread | null, activeChannelId: string): OpenThread | null {
  return thread && thread.channelId !== activeChannelId ? null : thread;
}
