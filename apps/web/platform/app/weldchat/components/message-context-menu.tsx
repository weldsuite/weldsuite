import { useState, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Reply,
  MessageSquare,
  Smile,
  Bookmark,
  Pin,
  PinOff,
  Forward,
  Link,
  MailOpen,
  Copy,
  Trash2,
  Eye,
} from 'lucide-react';
import {
  usePinMessage,
  useUnpinMessage,
  usePinnedMessages,
  useBookmarkMessage,
  useBookmarks,
  useDeleteBookmark,
  useDeleteMessage,
  useToggleReaction,
  useMarkChannelUnread,
  useSendMessage,
} from '@/hooks/queries/use-weldchat-queries';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import { useChatContext } from './chat-context';
import { ForwardMessageDialog } from './forward-message-dialog';
import { ReplacePinDialog } from './replace-pin-dialog';
import { PinDurationDialog } from './pin-duration-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

interface ReadByUser {
  userId: string;
  userName: string;
  userAvatar?: string;
}

interface MessageContextMenuProps {
  message: any;
  channelId: string;
  readBy?: ReadByUser[];
  children: ReactNode;
}

export function MessageContextMenu({ message, channelId, readBy, children }: MessageContextMenuProps) {
  const { t } = useI18n();
  const { data: pinnedData } = usePinnedMessages(channelId);
  const { mutate: pinMessage } = usePinMessage();
  const { mutate: unpinMessage } = useUnpinMessage();
  const { mutate: bookmarkMessage } = useBookmarkMessage();
  const { data: bookmarksData } = useBookmarks();
  const { mutate: deleteBookmark } = useDeleteBookmark();
  const existingBookmark = (bookmarksData?.data || []).find((bk: any) => bk.messageId === message.id);
  const isBookmarked = !!existingBookmark;
  const { mutate: deleteMessage } = useDeleteMessage();
  const { mutate: toggleReaction } = useToggleReaction();
  const { mutate: markUnread } = useMarkChannelUnread();
  const { mutate: sendMessage } = useSendMessage();
  const { setReplyTo, openThread } = useChatContext();
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  const [showReplacePinDialog, setShowReplacePinDialog] = useState(false);
  const [showPinDurationDialog, setShowPinDurationDialog] = useState(false);
  const [pendingReplaceId, setPendingReplaceId] = useState<string | null>(null);
  const pinnedMessages: any[] = pinnedData?.data ?? [];

  const handleReaction = (emoji: string) => {
    toggleReaction({ channelId, messageId: message.id, emoji, hasReacted: false });
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/weldchat/${channelId}?msg=${message.id}`;
    navigator.clipboard.writeText(url);
    toast.success(t.weldchat.messageContextMenu.messageLinkCopied);
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(message.content);
    toast.success(t.weldchat.messageContextMenu.messageTextCopied);
  };

  const handleMarkUnread = () => {
    markUnread({ channelId, beforeMessageId: message.id });
    toast.success(t.weldchat.messageContextMenu.markedAsUnread);
  };

  const handlePin = () => {
    if (message.isPinned) {
      unpinMessage({ channelId, messageId: message.id });
    } else if (pinnedMessages.length >= 3) {
      setShowReplacePinDialog(true);
    } else {
      setShowPinDurationDialog(true);
    }
  };

  const handleReplacePin = (messageIdToUnpin: string) => {
    setPendingReplaceId(messageIdToUnpin);
    setShowReplacePinDialog(false);
    setShowPinDurationDialog(true);
  };

  const handlePinWithDuration = (expiresAt?: string, notify?: boolean) => {
    const pinAndAlert = () => {
      if (notify) {
        sendMessage({ channelId, content: `[system:${message.id}] pinned a message` });
      }
      pinMessage({ channelId, messageId: message.id, expiresAt, notify });
    };

    if (pendingReplaceId) {
      unpinMessage(
        { channelId, messageId: pendingReplaceId },
        {
          onSuccess: () => {
            setPendingReplaceId(null);
            pinAndAlert();
          },
        },
      );
    } else {
      pinAndAlert();
    }
  };

  const handleDelete = () => {
    deleteMessage({ channelId, messageId: message.id });
    toast.success(t.weldchat.messageContextMenu.messageDeleted);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Smile className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageContextMenu.addReaction}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-auto min-w-0 px-2 py-1.5 rounded-[13px]">
              <div className="flex gap-1">
                {QUICK_REACTIONS.map((emoji) => (
                  <Button
                    key={emoji}
                    variant="ghost"
                    onClick={() => handleReaction(emoji)}
                    className="text-lg hover:bg-accent rounded-lg px-1.5 py-1.5 leading-none transition-colors"
                  >
                    {emoji}
                  </Button>
                ))}
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleMarkUnread}>
            <MailOpen className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.markAsUnread}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              setReplyTo({
                messageId: message.id,
                authorName: message.authorName,
                content: message.content,
              })
            }
          >
            <Reply className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.reply}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openThread(message.id)}>
            <MessageSquare className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.replyInThread}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setShowForwardDialog(true)}>
            <Forward className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.forwardMessage}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handlePin}>
            {message.isPinned ? (
              <PinOff className="h-4 w-4 mr-0.5" />
            ) : (
              <Pin className="h-4 w-4 mr-0.5" />
            )}
            {message.isPinned ? t.weldchat.messageContextMenu.unpinMessage : t.weldchat.messageContextMenu.pinMessage}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              isBookmarked
                ? deleteBookmark(existingBookmark.id)
                : bookmarkMessage({ messageId: message.id, channelId })
            }
          >
            <Bookmark className={`h-4 w-4 mr-0.5 ${isBookmarked ? 'fill-current' : ''}`} />
            {isBookmarked ? t.weldchat.messageContextMenu.removeBookmark : t.weldchat.messageContextMenu.saveMessage}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleCopyLink}>
            <Link className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.copyMessageLink}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyText}>
            <Copy className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.copyText}
          </ContextMenuItem>
          {readBy && readBy.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Eye className="h-4 w-4 mr-0.5" />
                  {t.weldchat.messageContextMenu.seenBy} {readBy.length}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="min-w-[200px] max-h-[300px] overflow-y-auto">
                  {readBy.map((user) => (
                    <div key={user.userId} className="flex items-center gap-2 px-2 py-1.5">
                      <Avatar className="h-5 w-5 !rounded-[6px]">
                        {user.userAvatar && <AvatarImage src={user.userAvatar} className="!rounded-[6px]" />}
                        <AvatarFallback className="text-[8px] !rounded-[6px]">
                          {(user.userName || '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate">{user.userName}</span>
                    </div>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive focus:bg-red-500/10">
            <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
            {t.weldchat.messageContextMenu.deleteMessage}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ForwardMessageDialog
        open={showForwardDialog}
        onOpenChange={setShowForwardDialog}
        messageContent={message.content}
        originalAuthor={message.authorName}
        messageId={message.id}
        sourceChannelId={channelId}
      />

      <ReplacePinDialog
        open={showReplacePinDialog}
        onOpenChange={(open) => {
          setShowReplacePinDialog(open);
          if (!open) setPendingReplaceId(null);
        }}
        pinnedMessages={pinnedMessages}
        onReplace={handleReplacePin}
      />

      <PinDurationDialog
        open={showPinDurationDialog}
        onOpenChange={(open) => {
          setShowPinDurationDialog(open);
          if (!open) setPendingReplaceId(null);
        }}
        onPin={handlePinWithDuration}
      />
    </>
  );
}
