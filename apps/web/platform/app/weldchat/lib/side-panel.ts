import type { RightPanel } from '../components/chat-context';

/** Where the chat is, as the side panel needs it. */
export interface SidePanelLocation {
  /** The conversation segment of the address: a channel id, or in a DM the other person's id. */
  currentChannelId: string;
  /** The conversation the open page reports (a DM's own channel id). */
  activeChannelId: string | null;
  isDmPage: boolean;
}

/**
 * The conversation the side panel shows `panel` for, or null when it shows
 * nothing. In a channel that is the channel in the address. A DM's address
 * holds the other person's id, so a thread there uses the id the DM page
 * reports; pinned messages are not offered in a DM, and bookmarks and filters
 * don't depend on the conversation.
 */
export function sidePanelChannelId(panel: RightPanel, location: SidePanelLocation): string | null {
  const { currentChannelId, activeChannelId, isDmPage } = location;
  if (!panel || !currentChannelId) return null;
  if (!isDmPage) return currentChannelId;
  if (panel === 'thread') return activeChannelId;
  if (panel === 'bookmarks' || panel === 'filters') return currentChannelId;
  return null;
}
