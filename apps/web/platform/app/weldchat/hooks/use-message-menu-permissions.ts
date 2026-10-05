import { useAuth } from '@clerk/clerk-react';
import { useChannel, useChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import {
  canDeleteMessage,
  canReactInChannel,
  canStartThread,
  isOwnMessage,
  type MessageMenuChannel,
} from '../lib/message-menu-rules';

export interface MessageMenuPermissions {
  canReact: boolean;
  canReplyInThread: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** Which actions the hover bar / right-click menu offers for `message`. */
export function useMessageMenuPermissions(message: ChatMessage, channelId: string): MessageMenuPermissions {
  const { userId } = useAuth();
  const { data: channelData } = useChannel(channelId);
  const { data: membersData } = useChannelMembers(channelId);
  const channel = channelData?.data as MessageMenuChannel | undefined;
  const myRole = (membersData?.data ?? []).find((m) => m.userId === userId)?.role;

  return {
    canReact: canReactInChannel(channel),
    canReplyInThread: canStartThread(message, channel),
    canEdit: isOwnMessage(message, userId),
    canDelete: canDeleteMessage(message, userId, myRole),
  };
}
