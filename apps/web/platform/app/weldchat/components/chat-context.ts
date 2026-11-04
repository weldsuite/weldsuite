import { createContext, useContext } from 'react';

export type RightPanel = 'thread' | 'pinned' | 'bookmarks' | 'filters' | null;
export type FilterType = 'all' | 'messages' | 'files' | 'images' | 'links';

export interface ChatFilters {
  type: FilterType;
  search: string;
  from: string[];
  date: Date | undefined;
}

export interface ReplyTo {
  messageId: string;
  authorName: string;
  content: string;
  /**
   * Thread the quoted message lives in (its own `parentId`), so only the
   * composer that owns that thread reacts. Omit for a channel-level message.
   */
  parentId?: string | null;
  /** Chain depth of the quoted message itself (0 for a plain message). */
  depth?: number;
  /** Message that started the quoted message's reply chain. */
  rootId?: string;
}

export interface EditingMessage {
  messageId: string;
  content: string;
  /**
   * Thread the edited message lives in (its own `parentId`), so only the
   * composer that owns that thread loads it. Omit for a channel-level message.
   */
  parentId?: string | null;
  /** The message's attachments, so images placed in its text show while editing. */
  attachments?: ReadonlyArray<{ id: string; url?: string; fileName?: string }>;
}

export interface ChatContextValue {
  activeChannelId: string | null;
  setActiveChannelId: (channelId: string | null) => void;
  rightPanel: RightPanel;
  setRightPanel: (panel: RightPanel) => void;
  threadMessageId: string | null;
  openThread: (messageId: string) => void;
  closeThread: () => void;
  replyTo: ReplyTo | null;
  setReplyTo: (reply: ReplyTo | null) => void;
  editingMessage: EditingMessage | null;
  setEditingMessage: (message: EditingMessage | null) => void;
  filters: ChatFilters;
  setFilters: (filters: ChatFilters) => void;
  selectedProfileUserId: string | null;
  openUserProfile: (userId: string) => void;
  closeUserProfile: () => void;
  selectedAgentProfileId: string | null;
  openAgentProfile: (agentId: string) => void;
  closeAgentProfile: () => void;
}

/** Window event that moves focus back to a composer (see MessageInput). */
export const FOCUS_INPUT_EVENT = 'weldchat-focus-input';

export interface FocusInputDetail {
  /** Only the composer of this thread takes focus (`null`: the channel composer). */
  parentId: string | null;
}

/**
 * Ask one composer for focus once the menu or popover that triggered this has
 * closed. Without a detail every mounted composer reacts, as before.
 */
export function requestComposerFocus(parentId: string | null) {
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent<FocusInputDetail>(FOCUS_INPUT_EVENT, { detail: { parentId } })),
  );
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export const useChatContext = () => {
  const ctx = useContext(ChatContext);
  if (!ctx)
    throw new Error('useChatContext must be used within ChatLayoutClient');
  return ctx;
};
