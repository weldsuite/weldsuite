import { createContext, useContext } from 'react';

export type RightPanel = 'thread' | 'members' | 'pinned' | 'bookmarks' | 'filters' | null;
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
  filters: ChatFilters;
  setFilters: (filters: ChatFilters) => void;
  selectedProfileUserId: string | null;
  openUserProfile: (userId: string) => void;
  closeUserProfile: () => void;
  selectedAgentProfileId: string | null;
  openAgentProfile: (agentId: string) => void;
  closeAgentProfile: () => void;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export const useChatContext = () => {
  const ctx = useContext(ChatContext);
  if (!ctx)
    throw new Error('useChatContext must be used within ChatLayoutClient');
  return ctx;
};
