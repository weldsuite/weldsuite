/**
 * What the message menus (hover bar + right-click menu) may offer for a
 * message. They mirror what the API enforces, so an action the server would
 * reject (400 / 403) is not offered in the first place.
 */

/** The channel feature locks the menus care about (`undefined` = not loaded yet = allowed). */
export interface MessageMenuChannel {
  /** 'dm' and 'group' are direct messages. */
  type?: string | null;
  threadsEnabled?: boolean | null;
  reactionsEnabled?: boolean | null;
}

/** Channel roles the API treats as moderators (they may delete other people's messages). */
const MODERATOR_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Reactions can be switched off per channel in its settings. */
export function canReactInChannel(channel: MessageMenuChannel | null | undefined): boolean {
  return channel?.reactionsEnabled !== false;
}

/**
 * Whether new threads may be started in a conversation: threads enabled on
 * the channel, and not a direct message (a DM is a conversation already;
 * threads made there before still open from their reply count).
 */
export function channelOffersThreads(channel: MessageMenuChannel | null | undefined): boolean {
  return channel?.threadsEnabled !== false && channel?.type !== 'dm' && channel?.type !== 'group';
}

/**
 * "Reply in thread" where the conversation offers threads, and never on a
 * message that is itself a thread reply (no threads inside threads).
 */
export function canStartThread(
  message: { parentId?: string | null },
  channel: MessageMenuChannel | null | undefined,
): boolean {
  return channelOffersThreads(channel) && !message.parentId;
}

export function isOwnMessage(message: { authorId?: string | null }, userId: string | null | undefined): boolean {
  return !!userId && message.authorId === userId;
}

/**
 * Delete is offered to the author and to channel owners / admins, which is what
 * `DELETE /api/chat-messages/:id` accepts (workspace admins are accepted too,
 * but the client has no signal for that, so they use the API's own check).
 */
export function canDeleteMessage(
  message: { authorId?: string | null },
  userId: string | null | undefined,
  channelRole: string | null | undefined,
): boolean {
  return isOwnMessage(message, userId) || (!!channelRole && MODERATOR_ROLES.has(channelRole));
}
