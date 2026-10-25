import { NON_CHANNEL_SEGMENTS } from './route-segments';

/**
 * The page `/weldchat` reopens: the last WeldChat page the user had open,
 * stored per user and workspace in `uiPreferences.weldchatLastPath`.
 *
 * Only the module's real page shapes are remembered, and each one says what
 * must still exist before it can be reopened: nothing for the module's own
 * pages, the channel for a channel, thread or group DM page, the other member
 * for a 1:1 DM page.
 */
export type LastWeldChatPage =
  | { kind: 'page'; path: string }
  | { kind: 'channel'; path: string; channelId: string }
  | { kind: 'dm'; path: string; userId: string };

/** Module pages that exist for everyone who can open WeldChat. */
const MODULE_PAGES: ReadonlySet<string> = new Set([
  'dm',
  'activity',
  'drafts',
  'directories',
  'bookmarks',
  'records',
  'search',
]);

const SEGMENT = '([^/?#]+)';
const GROUP_DM = new RegExp(`^/weldchat/dm/group/${SEGMENT}$`);
const DM = new RegExp(`^/weldchat/dm/${SEGMENT}$`);
const THREAD = new RegExp(`^/weldchat/${SEGMENT}/thread/${SEGMENT}$`);
const TOP_LEVEL = new RegExp(`^/weldchat/${SEGMENT}$`);

export function parseLastWeldChatPage(pathname: string | null | undefined): LastWeldChatPage | null {
  if (!pathname) return null;
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  const groupDm = GROUP_DM.exec(path);
  if (groupDm) return { kind: 'channel', path, channelId: groupDm[1] };

  const dm = DM.exec(path);
  if (dm) return dm[1] === 'group' ? null : { kind: 'dm', path, userId: dm[1] };

  const thread = THREAD.exec(path);
  if (thread) return NON_CHANNEL_SEGMENTS.has(thread[1]) ? null : { kind: 'channel', path, channelId: thread[1] };

  const segment = TOP_LEVEL.exec(path)?.[1];
  if (!segment) return null;
  if (MODULE_PAGES.has(segment)) return { kind: 'page', path };
  if (NON_CHANNEL_SEGMENTS.has(segment)) return null;
  return { kind: 'channel', path, channelId: segment };
}
