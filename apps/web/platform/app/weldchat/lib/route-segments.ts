/**
 * Which part of a `/weldchat/...` URL names a conversation.
 *
 * `/weldchat/<segment>` is a channel id UNLESS the segment is one of the
 * module's own sibling routes. Those pages (`dm`, `activity`, `drafts`, …) are
 * not conversations, so the layout must not fetch a channel, open the channel
 * panel or count them as the "active" channel for them.
 */
export const NON_CHANNEL_SEGMENTS: ReadonlySet<string> = new Set([
  'dm',
  'activity',
  'drafts',
  'directories',
  'bookmarks',
  'search',
  'thread',
]);

export interface WeldChatLocation {
  /**
   * Id of the open conversation: the channel id on a channel page, the other
   * member's user id on a 1:1 DM page (`/weldchat/dm/<userId>`), the channel id
   * on a group DM page. Empty when the URL names no conversation.
   */
  channelId: string;
  /** A real channel page (`/weldchat/<channelId>[/thread/...]`). */
  isChannelPage: boolean;
  /** A 1:1 or group DM page. */
  isDmPage: boolean;
  /** A group DM page (`/weldchat/dm/group/<channelId>`). */
  isGroupDm: boolean;
}

const NO_CONVERSATION: WeldChatLocation = { channelId: '', isChannelPage: false, isDmPage: false, isGroupDm: false };

export function parseWeldChatPath(pathname: string | null | undefined): WeldChatLocation {
  if (!pathname) return NO_CONVERSATION;

  const groupDm = /\/weldchat\/dm\/group\/([^/]+)/.exec(pathname);
  if (groupDm?.[1]) return { channelId: groupDm[1], isChannelPage: false, isDmPage: true, isGroupDm: true };

  const dm = /\/weldchat\/dm\/([^/]+)/.exec(pathname);
  // `/weldchat/dm/group` without an id is not a conversation either.
  if (dm?.[1] && dm[1] !== 'group') return { channelId: dm[1], isChannelPage: false, isDmPage: true, isGroupDm: false };

  const segment = /\/weldchat\/([^/]+)/.exec(pathname)?.[1];
  if (!segment || NON_CHANNEL_SEGMENTS.has(segment)) return NO_CONVERSATION;

  return { channelId: segment, isChannelPage: true, isDmPage: false, isGroupDm: false };
}
