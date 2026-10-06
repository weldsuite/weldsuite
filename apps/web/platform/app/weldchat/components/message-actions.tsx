import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Reply,
  MessageSquare,
  Smile,
  Bookmark,
  Pin,
  PinOff,
  MoreHorizontal,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { useChatContext } from './chat-context';
import { replyToFromMessage } from './reply-chain';
import { ForwardMessageDialog } from './forward-message-dialog';
import { ReplacePinDialog } from './replace-pin-dialog';
import { PinDurationDialog } from './pin-duration-dialog';
import { DeleteMessageDialog } from './delete-message-dialog';
import { useMessageMenuPermissions } from '../hooks/use-message-menu-permissions';
import { useTranslations } from '@weldsuite/i18n/client';
import { toast } from 'sonner';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

interface ReadByUser {
  userId: string;
  userName: string;
  userAvatar?: string;
}

interface MessageActionsProps {
  message: ChatMessage;
  channelId: string;
  readBy?: ReadByUser[];
  onOpenChange?: (open: boolean) => void;
}

export function MessageActions({ message, channelId, readBy, onOpenChange }: Readonly<MessageActionsProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const { canReact, canReplyInThread, canEdit, canDelete } = useMessageMenuPermissions(message, channelId);
  const { data: pinnedData } = usePinnedMessages(channelId);
  const { mutate: pinMessage } = usePinMessage();
  const { mutateAsync: unpinMessage } = useUnpinMessage();
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
  // Radix returns focus to the trigger when the menu closes, which would undo
  // the composer focus that Reply / Reply in thread just requested. For those
  // actions, leave focus where the composer put it.
  const focusComposerOnCloseRef = useRef(false);
  const handleCloseAutoFocus = (event: Event) => {
    if (!focusComposerOnCloseRef.current) return;
    focusComposerOnCloseRef.current = false;
    event.preventDefault();
  };
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Radix closes the dropdown in the same event that opens a dialog from it, and
  // that close would tell the parent the bar no longer needs to stay visible
  // (unmounting it, and the dialog with it). A ref, because state is stale here.
  const dialogOpenRef = useRef(false);
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  const [showReplacePinDialog, setShowReplacePinDialog] = useState(false);
  const [showPinDurationDialog, setShowPinDurationDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingReplaceId, setPendingReplaceId] = useState<string | null>(null);
  const pinnedMessages: ChatMessage[] = pinnedData?.data ?? [];

  const refocusInput = () => {
    // Defer one frame so the popover/dropdown has finished closing and
    // released focus before we move it back to the chat input.
    requestAnimationFrame(() => window.dispatchEvent(new Event('weldchat-focus-input')));
  };

  const handleEmojiOpenChange = (open: boolean) => {
    setShowEmojiPicker(open);
    onOpenChange?.(open || dropdownOpen);
    if (!open && !dropdownOpen) refocusInput();
  };

  const handleDropdownOpenChange = (open: boolean) => {
    setDropdownOpen(open);
    onOpenChange?.(open || showEmojiPicker || dialogOpenRef.current);
    if (!open && !showEmojiPicker && !dialogOpenRef.current) refocusInput();
  };

  const handleReaction = (emoji: string) => {
    // The hook rolls the optimistic update back on failure; tell the user why
    // the reaction vanished (e.g. reactions switched off for this channel).
    toggleReaction(
      {
        channelId,
        messageId: message.id,
        emoji,
        hasReacted: false,
      },
      { onError: () => toast.error(st('sweep.weldchat.messageMenus.reactionFailed')) },
    );
    setShowEmojiPicker(false);
    onOpenChange?.(false);
    refocusInput();
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}/weldchat/${channelId}?msg=${message.id}`;
    void navigator.clipboard.writeText(url);
    toast.success(t.weldchat.messageActionsBar.messageLinkCopied);
  };

  const handleCopyText = () => {
    void navigator.clipboard.writeText(message.content ?? '');
    toast.success(t.weldchat.messageActionsBar.messageTextCopied);
  };

  const handleMarkUnread = () => {
    markUnread({ channelId, beforeMessageId: message.id });
    toast.success(t.weldchat.messageActionsBar.markedAsUnread);
  };

  const handlePin = () => {
    if (message.isPinned) {
      unpinMessage({ channelId, messageId: message.id }).catch(() => undefined);
    } else if (pinnedMessages.length >= 3) {
      // At limit — first pick which to replace
      dialogOpenRef.current = true;
      setDropdownOpen(false);
      setShowReplacePinDialog(true);
      onOpenChange?.(true);
    } else {
      // Under limit — show duration picker directly
      dialogOpenRef.current = true;
      setDropdownOpen(false);
      setShowPinDurationDialog(true);
      onOpenChange?.(true);
    }
  };

  const handleReplacePin = (messageIdToUnpin: string) => {
    // Store which message to unpin, then show duration picker
    setPendingReplaceId(messageIdToUnpin);
    setShowReplacePinDialog(false);
    setShowPinDurationDialog(true);
  };

  const handlePinWithDuration = (expiresAt?: string, notify?: boolean) => {
    // With `notify` the server posts the "pinned a message" notice itself.
    const pinAndAlert = () => {
      pinMessage({ channelId, messageId: message.id, expiresAt, notify });
      onOpenChange?.(false);
    };

    if (pendingReplaceId) {
      // The hover bar may unmount mid-request, so continue from the promise.
      unpinMessage({ channelId, messageId: pendingReplaceId })
        .then(() => {
          setPendingReplaceId(null);
          pinAndAlert();
        })
        .catch(() => undefined);
    } else {
      pinAndAlert();
    }
  };

  const handleDelete = () => {
    setShowDeleteDialog(false);
    dialogOpenRef.current = false;
    onOpenChange?.(false);
    deleteMessage({ channelId, messageId: message.id }).then(
      () => toast.success(t.weldchat.messageActionsBar.messageDeleted),
      () => toast.error(t.weldchat.messageContextMenu.messageDeleteFailed),
    );
  };

  const handleEdit = () => {
    focusComposerOnCloseRef.current = true;
    setReplyTo(null);
    setEditingMessage({ messageId: message.id, content: message.content ?? '', parentId: message.parentId });
  };

  const handleDeleteRequest = () => {
    dialogOpenRef.current = true;
    setDropdownOpen(false);
    setShowDeleteDialog(true);
    onOpenChange?.(true);
  };

  const handleForward = () => {
    dialogOpenRef.current = true;
    setDropdownOpen(false);
    setShowForwardDialog(true);
    onOpenChange?.(true);
  };

  return (
    <>
      <div className="absolute -top-3 right-4 flex items-center gap-0.5 bg-background border rounded-[12px] shadow-sm p-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={t.weldchat.messageActionsBar.reply}
          onClick={() =>
            setReplyTo(replyToFromMessage(message))
          }
        >
          <Reply className="h-3.5 w-3.5" />
        </Button>
        {canReplyInThread && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t.weldchat.messageActionsBar.replyInThread}
            onClick={() => openThread(message.id)}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}
        {canReact && (
        <Popover open={showEmojiPicker} onOpenChange={handleEmojiOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7", showEmojiPicker && "bg-accent")}
              title={t.weldchat.messageActionsBar.addReaction}
            >
              <Smile className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={10} className="w-auto px-2 py-1.5 rounded-[13px]">
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
          </PopoverContent>
        </Popover>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title={isBookmarked ? t.weldchat.messageActionsBar.removeBookmark : t.weldchat.messageActionsBar.save}
          onClick={() =>
            isBookmarked
              ? deleteBookmark(existingBookmark.id)
              : bookmarkMessage({ messageId: message.id, channelId })
          }
        >
          <Bookmark className={`h-3.5 w-3.5 ${isBookmarked ? 'fill-current' : ''}`} />
        </Button>
        <DropdownMenu open={dropdownOpen} onOpenChange={handleDropdownOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={cn("h-7 w-7", dropdownOpen && "bg-accent")}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={handleCloseAutoFocus}>
            {canReact && (
            <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Smile className="h-4 w-4 mr-0.5" />
                {t.weldchat.messageActionsBar.addReaction}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <div className="flex gap-1 p-2">
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
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            </>
            )}
            <DropdownMenuItem onClick={handleMarkUnread}>
              <MailOpen className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageActionsBar.markAsUnread}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                focusComposerOnCloseRef.current = true;
                setReplyTo(replyToFromMessage(message));
              }}
            >
              <Reply className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageActionsBar.reply}
            </DropdownMenuItem>
            {canReplyInThread && (
              <DropdownMenuItem onClick={() => { focusComposerOnCloseRef.current = true; openThread(message.id); }}>
                <MessageSquare className="h-4 w-4 mr-0.5" />
                {t.weldchat.messageActionsBar.replyInThread}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleForward}>
              <Forward className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageActionsBar.forwardMessage}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handlePin}>
              {message.isPinned ? (
                <PinOff className="h-4 w-4 mr-0.5" />
              ) : (
                <Pin className="h-4 w-4 mr-0.5" />
              )}
              {message.isPinned ? t.weldchat.messageActionsBar.unpinMessage : t.weldchat.messageActionsBar.pinMessage}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                isBookmarked
                  ? deleteBookmark(existingBookmark.id)
                  : bookmarkMessage({ messageId: message.id, channelId })
              }
            >
              <Bookmark className={`h-4 w-4 mr-0.5 ${isBookmarked ? 'fill-current' : ''}`} />
              {isBookmarked ? t.weldchat.messageActionsBar.removeBookmark : t.weldchat.messageActionsBar.saveMessage}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleCopyLink}>
              <Link className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageActionsBar.copyMessageLink}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyText}>
              <Copy className="h-4 w-4 mr-0.5" />
              {t.weldchat.messageActionsBar.copyText}
            </DropdownMenuItem>
            {readBy && readBy.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Eye className="h-4 w-4 mr-0.5" />
                    {t.weldchat.messageActionsBar.seenBy} {readBy.length}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[200px] max-h-[300px] overflow-y-auto">
                    {readBy.map((user) => (
                      <div
                        key={user.userId}
                        className="flex items-center gap-2 px-2 py-1.5"
                      >
                        <Avatar className="h-5 w-5 !rounded-[6px]">
                          {user.userAvatar && <AvatarImage src={user.userAvatar} className="!rounded-[6px]" />}
                          <AvatarFallback className="text-[8px] !rounded-[6px]">
                            {(user.userName || '?')[0].toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm truncate">{user.userName}</span>
                      </div>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
            {(canEdit || canDelete) && <DropdownMenuSeparator />}
            {canEdit && (
              <DropdownMenuItem onClick={handleEdit}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.weldchat.messageContextMenu.editMessage}
              </DropdownMenuItem>
            )}
            {canDelete && (
              <DropdownMenuItem onClick={handleDeleteRequest} className="text-destructive focus:text-destructive focus:bg-red-500/10">
                <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                {t.weldchat.messageActionsBar.deleteMessage}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ForwardMessageDialog
        open={showForwardDialog}
        onOpenChange={(open) => {
          setShowForwardDialog(open);
          if (!open) { dialogOpenRef.current = false; onOpenChange?.(false); }
        }}
        messageContent={message.content ?? ''}
        originalAuthor={message.authorName ?? ''}
        messageId={message.id}
        sourceChannelId={channelId}
      />

      <DeleteMessageDialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          setShowDeleteDialog(open);
          if (!open) { dialogOpenRef.current = false; onOpenChange?.(false); }
        }}
        onConfirm={handleDelete}
      />

      <ReplacePinDialog
        open={showReplacePinDialog}
        onOpenChange={(open) => {
          setShowReplacePinDialog(open);
          if (!open) { dialogOpenRef.current = false; setPendingReplaceId(null); onOpenChange?.(false); }
        }}
        pinnedMessages={pinnedMessages}
        onReplace={handleReplacePin}
      />

      <PinDurationDialog
        open={showPinDurationDialog}
        onOpenChange={(open) => {
          setShowPinDurationDialog(open);
          if (!open) { dialogOpenRef.current = false; setPendingReplaceId(null); onOpenChange?.(false); }
        }}
        onPin={handlePinWithDuration}
      />
    </>
  );
}
