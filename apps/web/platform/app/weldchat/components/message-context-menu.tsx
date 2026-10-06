import { useRef, useState, type ReactNode } from 'react';
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
  Pencil,
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
} from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
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
import { replyToFromMessage } from './reply-chain';
import { ForwardMessageDialog } from './forward-message-dialog';
import { ReplacePinDialog } from './replace-pin-dialog';
import { PinDurationDialog } from './pin-duration-dialog';
import { DeleteMessageDialog } from './delete-message-dialog';
import { useMessageMenuPermissions } from '../hooks/use-message-menu-permissions';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

interface ReadByUser {
  userId: string;
  userName: string;
  userAvatar?: string;
}

interface MessageContextMenuProps {
  message: ChatMessage;
  channelId: string;
  readBy?: ReadByUser[];
  children: ReactNode;
}

export function MessageContextMenu({ message, channelId, readBy, children }: Readonly<MessageContextMenuProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { canReact, canReplyInThread, canEdit, canDelete } = useMessageMenuPermissions(message, channelId);
  const { data: pinnedData } = usePinnedMessages(channelId);
  const { mutate: pinMessage } = usePinMessage();
  const { mutate: unpinMessage } = useUnpinMessage();
  const { mutate: bookmarkMessage } = useBookmarkMessage();
  const { data: bookmarksData } = useBookmarks();
  const { mutate: deleteBookmark } = useDeleteBookmark();
  const existingBookmark = (bookmarksData?.data || []).find((bk) => bk.messageId === message.id);
  const isBookmarked = !!existingBookmark;
  // mutateAsync: the optimistic removal unmounts this component, and mutate-level
  // callbacks die with their observer, so the toasts run from the returned promise.
  const { mutateAsync: deleteMessage } = useDeleteMessage();
  const { mutate: toggleReaction } = useToggleReaction();
  const { mutate: markUnread } = useMarkChannelUnread();
  const { setReplyTo, openThread, setEditingMessage } = useChatContext();
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  const [showReplacePinDialog, setShowReplacePinDialog] = useState(false);
  const [showPinDurationDialog, setShowPinDurationDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingReplaceId, setPendingReplaceId] = useState<string | null>(null);
  const pinnedMessages: ChatMessage[] = pinnedData?.data ?? [];

  const handleReaction = (emoji: string) => {
    // The hook rolls the optimistic update back on failure; tell the user why
    // the reaction vanished (e.g. reactions switched off for this channel).
    toggleReaction(
      { channelId, messageId: message.id, emoji, hasReacted: false },
      { onError: () => toast.error(st('sweep.weldchat.messageMenus.reactionFailed')) },
    );
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/weldchat/${channelId}?msg=${message.id}`;
    void navigator.clipboard.writeText(url);
    toast.success(t.weldchat.messageContextMenu.messageLinkCopied);
  };

  const handleCopyText = () => {
    void navigator.clipboard.writeText(message.content ?? '');
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
    // With `notify` the server posts the "pinned a message" notice itself.
    const pinAndAlert = () => {
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
    setShowDeleteDialog(false);
    deleteMessage({ channelId, messageId: message.id }).then(
      () => toast.success(t.weldchat.messageContextMenu.messageDeleted),
      () => toast.error(t.weldchat.messageContextMenu.messageDeleteFailed),
    );
  };

  // Radix hands focus back to the right-clicked message when the menu closes,
  // which would undo the composer focus that Reply / Reply in thread / Edit just
  // requested. For those actions, leave focus where the composer put it.
  const focusComposerOnCloseRef = useRef(false);
  const handleCloseAutoFocus = (event: Event) => {
    if (!focusComposerOnCloseRef.current) return;
    focusComposerOnCloseRef.current = false;
    event.preventDefault();
  };

  const handleEdit = () => {
    focusComposerOnCloseRef.current = true;
    setReplyTo(null);
    setEditingMessage({ messageId: message.id, content: message.content ?? '', parentId: message.parentId });
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-56" onCloseAutoFocus={handleCloseAutoFocus}>
          {canReact && (
          <>
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
          </>
          )}
          <ContextMenuItem onClick={handleMarkUnread}>
            <MailOpen className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.markAsUnread}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              focusComposerOnCloseRef.current = true;
              setReplyTo(replyToFromMessage(message));
            }}
          >
            <Reply className="h-4 w-4 mr-0.5" />
            {t.weldchat.messageContextMenu.reply}
          </ContextMenuItem>
          {canReplyInThread && (
            <ContextMenuItem onClick={() => { focusComposerOnCloseRef.current = true; openThread(message.id); }}>
              <MessageSquare className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageContextMenu.replyInThread}
            </ContextMenuItem>
          )}
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
          {(canEdit || canDelete) && <ContextMenuSeparator />}
          {canEdit && (
            <ContextMenuItem onClick={handleEdit}>
              <Pencil className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageContextMenu.editMessage}
            </ContextMenuItem>
          )}
          {canDelete && (
            <ContextMenuItem onClick={() => setShowDeleteDialog(true)} className="text-destructive focus:text-destructive focus:bg-red-500/10">
              <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
              {t.weldchat.messageContextMenu.deleteMessage}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <ForwardMessageDialog
        open={showForwardDialog}
        onOpenChange={setShowForwardDialog}
        messageContent={message.content ?? ''}
        originalAuthor={message.authorName ?? ''}
        messageId={message.id}
        sourceChannelId={channelId}
      />

      <DeleteMessageDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
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
