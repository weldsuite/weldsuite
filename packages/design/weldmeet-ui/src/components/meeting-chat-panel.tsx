/**
 * Shared Meeting Chat Panel — pure presentational component.
 *
 * Renders the exact same chat UI for both the platform (apps/web/platform) and the
 * meeting-portal (apps/web/meeting-portal). No Clerk, no realtime, no query hooks — all
 * data flows in as props. Each host app wires its own data layer and renders
 * this component.
 */

'use client';

import {
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
  useEffect,
  type ReactNode,
} from 'react';
import {
  X,
  Loader2,
  Paperclip,
  Smile,
  Plus,
  AtSign,
  Baseline,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Reply,
  Copy,
  Trash2,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';
import { EmptyStateIllustration } from './entity-list';
import { EmojiPicker } from './emoji-picker';
import { useIsMobile } from '../hooks/use-is-mobile';
import { sanitizeRichText, hasRichFormatting } from '../lib/sanitize-rich-text';

// ============================================================================
// Shared types
// ============================================================================

export interface ChatMessageAttachment {
  id?: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  url: string;
  /** Transient client-only flag while the file is uploading (no real URL yet). */
  _uploading?: boolean;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  content: string;
  /**
   * Rich-text HTML produced by the composer's formatting toolbar. When present,
   * the message renders this (sanitized) instead of plain `content`. `content`
   * stays as the plain-text fallback (notifications, previews).
   */
  htmlContent?: string | null;
  /** 'message' | 'system' */
  type: string;
  createdAt: string;
  attachments?: ChatMessageAttachment[];
  pinnedAt?: string | null;
  /** True while an optimistic send is in-flight */
  _optimistic?: boolean;
}

export interface ChatParticipant {
  id: string;
  name: string;
  avatar?: string | null;
  isGuest?: boolean;
}

export interface PinnedMessage {
  id: string;
  content: string;
}

// ============================================================================
// Props interface for the shared panel
// ============================================================================

export interface SharedMeetingChatPanelProps {
  /** Open / close state */
  isOpen: boolean;
  onClose: () => void;

  /** Message data */
  messages: ChatMessage[];
  isLoading?: boolean;

  /** Pagination — omit to hide "Load older messages" */
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onFetchNextPage?: () => void;

  /** Identity of the current viewer — used to show "(you)" label */
  currentUserId: string;
  currentUserName: string;

  /**
   * Send a new message. `html` is the sanitized rich-text body when the user
   * applied formatting (bold/italic/lists/…); omitted for plain messages.
   * Return a promise if you need error handling.
   */
  onSendMessage: (
    text: string,
    attachments?: ChatMessageAttachment[],
    html?: string,
  ) => Promise<void> | void;

  /**
   * Upload a selected file and resolve to its persisted attachment (with a real,
   * shareable `url`). When omitted, the attachment button is hidden — a local
   * blob URL is useless to other participants, so we don't offer attachments
   * unless the host app wires a real upload.
   */
  onUploadFile?: (file: File) => Promise<ChatMessageAttachment | null>;

  /** Participants list — used for future @-mention picker (no-op when empty) */
  participants?: ChatParticipant[];

  /** Active typing users — displayed below the input */
  typingUsers?: string[];

  /** Pinned messages — omit or pass empty array to hide the pinned bar */
  pinnedMessages?: PinnedMessage[];
  onPinMessage?: (messageId: string) => void;
  onUnpinMessage?: (messageId: string) => void;

  /** Whether the current viewer can delete messages */
  canDeleteMessage?: (message: ChatMessage) => boolean;
  onDeleteMessage?: (messageId: string) => void;

  /**
   * When true the action bar (reply, pin, delete, …) is suppressed for all
   * messages. Set this in the portal where guests have no moderation rights.
   * When omitted (or false) the full platform action bar is shown.
   */
  readOnlyActions?: boolean;

  /** Optional toast callback — called when user copies a message. Defaults to no-op. */
  onCopyToast?: (message: string) => void;

  /**
   * Open the author's detail panel when their name/avatar is clicked. Platform-
   * only — omit in the portal where guests have no detail panel. When provided,
   * the author name + avatar on non-compact messages from other people become
   * clickable.
   */
  onClickAuthor?: (author: { id: string; name: string; avatar?: string | null }) => void;

  /** Panel width override — defaults to 480. */
  width?: number;
}

// ============================================================================
// Root panel
// ============================================================================

export function SharedMeetingChatPanel(props: SharedMeetingChatPanelProps) {
  const { isOpen, onClose, width = 480 } = props;
  const isMobile = useIsMobile();

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        'flex flex-col min-h-0 overflow-hidden',
        // Mobile: full-screen sheet over the call. Desktop: fixed-width right dock.
        isMobile
          ? 'fixed inset-0 z-50 bg-background'
          : 'flex-shrink-0 border-l border-gray-200 dark:border-border',
      )}
      style={isMobile ? undefined : { width }}
    >
      <style>{`
        .wm-rich { white-space: pre-wrap; }
        .wm-rich ul, .wm-rich ol { padding-left: 1.5em; margin: 2px 0; white-space: normal; }
        .wm-rich ul { list-style-type: disc; }
        .wm-rich ol { list-style-type: decimal; }
        .wm-rich li { padding: 1px 0; }
      `}</style>
      <div
        className={cn('flex flex-col min-h-0 h-full', isMobile ? 'w-full' : 'flex-shrink-0')}
        style={isMobile ? undefined : { width: width - 1 }}
      >
        {/* Header */}
        <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
          <span className="text-sm font-semibold">Chat</span>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted transition-colors"
            aria-label="Close chat"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col flex-1 min-h-0">
          <PinnedBar
            pinnedMessages={props.pinnedMessages ?? []}
            onUnpin={props.onUnpinMessage}
          />
          <MessageList {...props} />
          <MessageInput {...props} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Pinned Messages Bar
// ============================================================================

function PinnedBar({
  pinnedMessages,
  onUnpin,
}: {
  pinnedMessages: PinnedMessage[];
  onUnpin?: (id: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (pinnedMessages.length === 0) return null;

  const safeIndex = activeIndex >= pinnedMessages.length ? 0 : activeIndex;
  const current = pinnedMessages[safeIndex] as PinnedMessage | undefined;

  const handleClick = () => {
    const nextIndex =
      pinnedMessages.length > 1 ? (safeIndex + 1) % pinnedMessages.length : safeIndex;
    setActiveIndex(nextIndex);

    const nextPinned = pinnedMessages[nextIndex];
    if (!nextPinned) return;
    const targetId = nextPinned.id;
    const el = document.querySelector(`[data-message-id="${targetId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pinned-highlight');
      setTimeout(() => el.classList.remove('pinned-highlight'), 1000);
    }
  };

  const handleUnpin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (current) onUnpin?.(current.id);
    if (safeIndex >= pinnedMessages.length - 1) {
      setActiveIndex(0);
    }
  };

  return (
    <>
      <style>{`
        @keyframes pinned-flash {
          0%   { background-color: transparent; }
          10%  { background-color: rgba(59, 130, 246, 0.12); }
          50%  { background-color: rgba(59, 130, 246, 0.12); }
          100% { background-color: transparent; }
        }
        .pinned-highlight {
          animation: pinned-flash 1s ease-out forwards;
        }
      `}</style>
      <div
        className="group border-b bg-muted/30 flex-shrink-0 flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={handleClick}
      >
        {pinnedMessages.length > 1 && (
          <div className="flex flex-col justify-center gap-[2px] flex-shrink-0 h-[20px]">
            {pinnedMessages.map((_: PinnedMessage, i: number) => (
              <div
                key={i}
                className={cn(
                  'w-[3px] rounded-full transition-all',
                  i === safeIndex ? 'flex-[2] bg-primary' : 'flex-1 bg-muted-foreground/30',
                )}
              />
            ))}
          </div>
        )}

        <Pin className="h-4 w-4 text-primary flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <span className="text-sm text-foreground truncate">{current?.content}</span>
        </div>

        {onUnpin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            onClick={handleUnpin}
            title="Unpin"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Message List
// ============================================================================

function MessageList(props: SharedMeetingChatPanelProps) {
  const {
    messages,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    onFetchNextPage,
    currentUserId,
    readOnlyActions,
    pinnedMessages,
    onPinMessage,
    onUnpinMessage,
    canDeleteMessage,
    onDeleteMessage,
    onCopyToast,
    onClickAuthor,
  } = props;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 150;
  };

  useLayoutEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const obs = new ResizeObserver(() => {
      if (!userScrolledUpRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    obs.observe(inner);
    return () => obs.disconnect();
  }, [isLoading]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 p-4">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <EmptyStateIllustration>
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Speech bubble */}
            <path
              d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z"
              className="fill-white dark:fill-white/[0.03]"
            />
            <path
              d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z"
              className="stroke-gray-200 dark:stroke-white/15"
              strokeWidth="1"
            />
            {/* Text lines */}
            <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          </svg>
        </EmptyStateIllustration>
        <h3 className="text-[15px] font-semibold text-foreground mb-1.5">No messages yet</h3>
        <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">
          Send a message to start chatting
        </p>
      </div>
    );
  }

  const pinnedIds = new Set((pinnedMessages ?? []).map((p) => p.id));

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-transparent hover:scrollbar-thumb-muted-foreground/20"
      style={{ scrollbarWidth: 'thin', scrollbarColor: 'transparent transparent' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.scrollbarColor = 'rgba(150,150,150,0.2) transparent';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.scrollbarColor = 'transparent transparent';
      }}
    >
      <div className="flex flex-col min-h-full py-4 space-y-1">
        <div className="flex-1" />

        {hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFetchNextPage?.()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Load older messages
            </Button>
          </div>
        )}

        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const msgTime = new Date(message.createdAt).getTime();
          const prevTime = prevMessage ? new Date(prevMessage.createdAt).getTime() : 0;
          const timeDiff = msgTime - prevTime;

          const isCompact =
            !!prevMessage &&
            prevMessage.authorId === message.authorId &&
            !isNaN(timeDiff) &&
            timeDiff >= 0 &&
            timeDiff < 300000;

          return (
            <div key={message.id}>
              <MessageItem
                message={message}
                compact={isCompact}
                isSelf={message.authorId === currentUserId}
                isPinned={pinnedIds.has(message.id)}
                readOnlyActions={readOnlyActions}
                onPin={onPinMessage}
                onUnpin={onUnpinMessage}
                canDelete={canDeleteMessage ? canDeleteMessage(message) : false}
                onDelete={onDeleteMessage}
                onCopyToast={onCopyToast}
                onClickAuthor={onClickAuthor}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Message Item
// ============================================================================

interface MessageItemProps {
  message: ChatMessage;
  compact: boolean;
  isSelf: boolean;
  isPinned: boolean;
  readOnlyActions?: boolean;
  onPin?: (id: string) => void;
  onUnpin?: (id: string) => void;
  canDelete: boolean;
  onDelete?: (id: string) => void;
  onCopyToast?: (msg: string) => void;
  onClickAuthor?: (author: { id: string; name: string; avatar?: string | null }) => void;
}

function MessageItem({
  message,
  compact,
  isSelf,
  isPinned,
  readOnlyActions,
  onPin,
  onUnpin,
  canDelete,
  onDelete,
  onCopyToast,
  onClickAuthor,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Shared hover state for the author affordance so hovering EITHER the avatar
  // or the name underlines the name (signals the whole author area is clickable).
  const [authorHovered, setAuthorHovered] = useState(false);

  const timeStr = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const fullTime = new Date(message.createdAt).toLocaleString();

  // Author detail panel — only for other people (not self) and only when the
  // host app wires the callback (platform). Portal omits it for guests.
  const authorClickable = !!onClickAuthor && !isSelf;
  const handleAuthorClick = () =>
    onClickAuthor?.({ id: message.authorId, name: message.authorName, avatar: message.authorAvatar });
  const authorHoverProps = authorClickable
    ? {
        onClick: handleAuthorClick,
        onMouseEnter: () => setAuthorHovered(true),
        onMouseLeave: () => setAuthorHovered(false),
        title: `View ${message.authorName}`,
      }
    : {};

  if (message.type === 'system') {
    return (
      <div className="flex justify-center py-1.5 px-4">
        <span className="inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1 text-muted-foreground bg-muted/70 dark:bg-muted/50">
          {message.content}
        </span>
      </div>
    );
  }

  const handleCopyText = () => {
    navigator.clipboard.writeText(message.content);
    onCopyToast?.('Message copied');
  };

  const handlePin = () => {
    if (isPinned) {
      onUnpin?.(message.id);
      onCopyToast?.('Message unpinned');
    } else {
      onPin?.(message.id);
      onCopyToast?.('Message pinned');
    }
  };

  const showActionBar = !readOnlyActions && (onPin || onUnpin || onDelete);

  return (
    <div
      data-message-id={message.id}
      className={cn(
        'group relative px-4 py-1 hover:bg-muted/50 transition-colors',
        compact && 'py-0.5',
        message._optimistic && 'opacity-60',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        if (!menuOpen) setIsHovered(false);
      }}
    >
      {/* Hover action bar */}
      {showActionBar && (isHovered || menuOpen) && !message._optimistic && (
        <div className="absolute -top-3 right-4 flex items-center gap-0.5 bg-background border rounded-[12px] shadow-sm p-1 z-10">
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Reply" onClick={() => {}}>
            <Reply className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Add reaction"
            onClick={() => {}}
          >
            <Smile className="h-3.5 w-3.5" />
          </Button>
          {(onPin || onUnpin) && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7', isPinned && 'text-primary')}
              title={isPinned ? 'Unpin message' : 'Pin message'}
              onClick={handlePin}
            >
              {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </Button>
          )}
          <DropdownMenu
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) setIsHovered(false);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-7 w-7', menuOpen && 'bg-accent')}
                title="More actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="w-44">
              {(onPin || onUnpin) && (
                <DropdownMenuItem onClick={handlePin}>
                  {isPinned ? (
                    <PinOff className="h-4 w-4 mr-0.5" />
                  ) : (
                    <Pin className="h-4 w-4 mr-0.5" />
                  )}
                  {isPinned ? 'Unpin message' : 'Pin message'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleCopyText}>
                <Copy className="h-4 w-4 mr-0.5" />
                Copy text
              </DropdownMenuItem>
              {canDelete && onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(message.id)}
                    className="text-red-500 focus:text-red-500"
                  >
                    <Trash2 className="h-4 w-4 mr-0.5" />
                    Delete message
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="flex gap-3">
        {compact ? (
          <div className="w-7 flex-shrink-0 flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
              {timeStr}
            </span>
          </div>
        ) : (
          <Avatar
            className={cn(
              'h-7 w-7 flex-shrink-0 mt-0.5 !rounded-[9px]',
              authorClickable && 'cursor-pointer',
            )}
            {...authorHoverProps}
          >
            {message.authorAvatar && (
              <AvatarImage src={message.authorAvatar} className="!rounded-[9px]" />
            )}
            <AvatarFallback className="text-[9px] !rounded-[9px]">
              {(message.authorName || '?')[0]?.toUpperCase() ?? '?'}
            </AvatarFallback>
          </Avatar>
        )}

        <div className="flex-1 min-w-0">
          {!compact && (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'font-semibold text-sm',
                  authorClickable && 'cursor-pointer',
                  authorClickable && authorHovered && 'underline',
                )}
                {...authorHoverProps}
              >
                {message.authorName}
                {isSelf && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">(you)</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground" title={fullTime}>
                {timeStr}
              </span>
            </div>
          )}

          {message.htmlContent ? (
            <div
              className="wm-rich text-sm break-words"
              // Sanitized at render — the security boundary. `htmlContent` may
              // originate from an untrusted meeting guest, so never drop this.
              dangerouslySetInnerHTML={{ __html: sanitizeRichText(message.htmlContent) }}
            />
          ) : (
            <div className="text-sm whitespace-pre-wrap break-words">{message.content}</div>
          )}

          {(message.attachments?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {(message.attachments ?? []).map((att, i) => (
                <a
                  key={att.id ?? i}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-xs hover:bg-muted/80 transition-colors"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{att.fileName}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Message Input
// ============================================================================

function MessageInput({
  onSendMessage,
  onUploadFile,
  currentUserName,
  currentUserId,
  participants,
}: SharedMeetingChatPanelProps) {
  const [content, setContent] = useState('');
  const [showToolbar, setShowToolbar] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<ChatMessageAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isUploading = uploadCount > 0;

  const handleSend = useCallback(async () => {
    const raw = editorRef.current?.innerText ?? content;
    const trimmed = raw.trim();
    // Capture the formatted HTML BEFORE we clear the editor. Sanitize it now so
    // only safe markup is ever sent/stored; only attach `html` when the user
    // actually applied formatting (otherwise the message stays plain text).
    const rawHtml = editorRef.current?.innerHTML ?? '';
    const sanitizedHtml = sanitizeRichText(rawHtml);
    const html = hasRichFormatting(sanitizedHtml) ? sanitizedHtml : undefined;
    // Allow attachment-only sends — but never send while a file is still
    // uploading (its `url` isn't real yet) or mid-send.
    const ready = attachments.filter((a) => !a._uploading);
    if (!trimmed && ready.length === 0) return;
    if (isSending || isUploading) return;

    setIsSending(true);
    const currentAttachments = ready;
    setContent('');
    setAttachments([]);
    if (editorRef.current) editorRef.current.innerHTML = '';

    try {
      await onSendMessage(trimmed, currentAttachments.length > 0 ? currentAttachments : undefined, html);
    } catch {
      // Restore content on failure so the user can retry
      setContent(trimmed);
      if (editorRef.current) editorRef.current.innerText = trimmed;
      setAttachments(currentAttachments);
    } finally {
      setIsSending(false);
    }
  }, [content, isSending, isUploading, attachments, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText ?? '';
    if (!text.trim()) {
      el.innerHTML = '';
    }
    setContent(text);
  };

  const updateActiveFormats = useCallback(() => {
    const formats = new Set<string>();
    if (document.queryCommandState('bold')) formats.add('bold');
    if (document.queryCommandState('italic')) formats.add('italic');
    if (document.queryCommandState('underline')) formats.add('underline');
    if (document.queryCommandState('strikeThrough')) formats.add('strikeThrough');
    if (document.queryCommandState('insertUnorderedList')) formats.add('insertUnorderedList');
    if (document.queryCommandState('insertOrderedList')) formats.add('insertOrderedList');
    setActiveFormats(formats);
  }, []);

  useEffect(() => {
    if (!showToolbar) return;
    document.addEventListener('selectionchange', updateActiveFormats);
    return () => document.removeEventListener('selectionchange', updateActiveFormats);
  }, [showToolbar, updateActiveFormats]);

  const applyFormat = useCallback(
    (command: string) => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      document.execCommand(command, false);
      updateActiveFormats();
      handleInput();
    },
    [updateActiveFormats],
  );

  const triggerMention = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const textNode = document.createTextNode('@');
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  // Append the emoji at the end of the message. We deliberately do NOT move
  // focus to the editor here so the emoji popover stays open for picking
  // several in a row; `content` is synced so the send button enables and Enter
  // sends. (handleSend also reads editor.innerText directly as a fallback.)
  const insertEmoji = useCallback((emoji: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.appendChild(document.createTextNode(emoji));
    setContent(el.innerText);
  }, []);

  // Insert an "@Name " mention from the participant picker. Appends with a
  // leading space when needed so it doesn't glue onto the previous word.
  const insertMention = useCallback((name: string) => {
    const el = editorRef.current;
    if (!el) return;
    const existing = el.innerText ?? '';
    const needsSpace = existing.length > 0 && !/\s$/.test(existing);
    el.appendChild(document.createTextNode(`${needsSpace ? ' ' : ''}@${name} `));
    setContent(el.innerText);
    setMentionOpen(false);
    el.focus();
  }, []);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (files.length === 0 || !onUploadFile) return;

      for (const file of files) {
        // Optimistic placeholder so the user sees the file immediately with a
        // spinner; replaced with the real attachment (shareable URL) once the
        // upload resolves, or removed on failure.
        const tempId = `uploading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const placeholder: ChatMessageAttachment = {
          id: tempId,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          url: '',
          _uploading: true,
        };
        setAttachments((prev) => [...prev, placeholder]);
        setUploadCount((n) => n + 1);

        try {
          const uploaded = await onUploadFile(file);
          setAttachments((prev) =>
            uploaded
              ? prev.map((a) => (a.id === tempId ? { ...uploaded, _uploading: false } : a))
              : prev.filter((a) => a.id !== tempId),
          );
        } catch (err) {
          console.error('[MeetingChat] File upload failed:', err);
          setAttachments((prev) => prev.filter((a) => a.id !== tempId));
        } finally {
          setUploadCount((n) => Math.max(0, n - 1));
        }
      }
    },
    [onUploadFile],
  );

  const btnClass =
    'p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnActiveClass =
    'p-1.5 rounded-lg transition-colors bg-gray-100 dark:bg-accent text-gray-700 dark:text-foreground';

  const isPending = isSending;
  // The send action is enabled for text OR at least one fully-uploaded
  // attachment — but never while a file is still uploading or a send is mid-air.
  const hasReadyAttachment = attachments.some((a) => !a._uploading);
  const canSend = (content.trim().length > 0 || hasReadyAttachment) && !isPending && !isUploading;

  return (
    <div className="p-4 flex-shrink-0">
      <style>{`
        [contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
        }
        [contenteditable] ul, [contenteditable] ol { padding-left: 1.5em; margin: 2px 0; }
        [contenteditable] ul { list-style-type: disc; }
        [contenteditable] ol { list-style-type: decimal; }
        [contenteditable] li { padding: 1px 0; }
      `}</style>

      <div
        className="relative bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[20px] p-[10px] w-full flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] cursor-text"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (
            !target.closest('button') &&
            !target.closest('[role="dialog"]') &&
            editorRef.current
          ) {
            editorRef.current.focus();
          }
        }}
      >
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3 px-[10px]">
            {attachments.map((att, i) => (
              <div
                key={i}
                className="relative group flex items-center gap-2 bg-gray-100 dark:bg-secondary rounded-lg px-3 py-2 text-sm"
              >
                {att._uploading ? (
                  <Loader2 className="h-3 w-3 text-gray-400 flex-shrink-0 animate-spin" />
                ) : (
                  <Paperclip className="h-3 w-3 text-gray-400 flex-shrink-0" />
                )}
                <span className="text-gray-700 dark:text-muted-foreground truncate max-w-[120px]">
                  {att.fileName}
                </span>
                <button
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="p-0.5 hover:bg-gray-200 dark:hover:bg-accent rounded"
                >
                  <X className="h-3.5 w-3.5 text-gray-400" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Formatting toolbar */}
        {showToolbar && (
          <div className="flex items-center gap-0.5 px-[10px] -mt-[2px] pt-[2px] pb-2 mb-2 border-b border-gray-100 dark:border-border/50">
            {(
              [
                { icon: Bold, command: 'bold', title: 'Bold' },
                { icon: Italic, command: 'italic', title: 'Italic' },
                { icon: Underline, command: 'underline', title: 'Underline' },
                { icon: Strikethrough, command: 'strikeThrough', title: 'Strikethrough' },
              ] as const
            ).map(({ icon: Icon, command, title }) => (
              <button
                key={command}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyFormat(command);
                }}
                className={activeFormats.has(command) ? btnActiveClass : btnClass}
                title={title}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
            <div className="w-px h-4 bg-gray-200 dark:bg-border mx-1" />
            {(
              [
                { icon: List, command: 'insertUnorderedList', title: 'Bullet list' },
                { icon: ListOrdered, command: 'insertOrderedList', title: 'Numbered list' },
              ] as const
            ).map(({ icon: Icon, command, title }) => (
              <button
                key={command}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyFormat(command);
                }}
                className={activeFormats.has(command) ? btnActiveClass : btnClass}
                title={title}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        )}

        {/* ContentEditable input */}
        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          data-placeholder="Type a message..."
          className="w-full bg-transparent text-[15px] text-gray-900 dark:text-foreground outline-none resize-none min-h-[40px] flex-1 pl-[10px] pt-[7px] pb-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}
          role="textbox"
          aria-label={`Message as ${currentUserName}`}
          aria-multiline="true"
        />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept="image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx"
        />

        {/* Bottom actions */}
        <div className="flex items-center justify-between mt-auto">
          <div className="flex items-center gap-0">
            {onUploadFile && (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending || isUploading}
                className={btnClass}
                title="Add attachment"
              >
                <Plus className="h-[18px] w-[18px]" />
              </button>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={isPending}
                  className={btnClass}
                  title="Emoji"
                >
                  <Smile className="h-[18px] w-[18px]" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                side="top"
                sideOffset={8}
                className="w-[340px] p-0"
              >
                <EmojiPicker onSelect={insertEmoji} />
              </PopoverContent>
            </Popover>
            {participants && participants.length > 0 ? (
              <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={isPending}
                    className={btnClass}
                    title="Mention someone"
                  >
                    <AtSign className="h-[18px] w-[18px]" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={8} className="w-[260px] p-0">
                  <MentionPicker
                    participants={participants}
                    currentUserId={currentUserId}
                    onSelect={(p) => insertMention(p.name)}
                  />
                </PopoverContent>
              </Popover>
            ) : (
              <button
                onClick={triggerMention}
                disabled={isPending}
                className={btnClass}
                title="Mention someone"
              >
                <AtSign className="h-[18px] w-[18px]" />
              </button>
            )}
            <button
              onClick={() => setShowToolbar((prev) => !prev)}
              disabled={isPending}
              className={showToolbar ? btnActiveClass : btnClass}
              title="Formatting"
            >
              <Baseline className="h-[18px] w-[18px]" />
            </button>
          </div>

          <button
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              'w-8 h-8 rounded-[12px] flex items-center justify-center transition-all',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-gray-300 dark:bg-muted text-gray-500 dark:text-muted-foreground cursor-not-allowed',
            )}
            title="Send message"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="3"
              stroke="currentColor"
              className={cn(
                'h-[15px] w-[15px]',
                canSend
                  ? 'text-primary-foreground'
                  : 'text-gray-500 dark:text-muted-foreground',
              )}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Mention Picker — searchable list of meeting participants
// ============================================================================

function MentionPicker({
  participants,
  currentUserId,
  onSelect,
}: {
  participants: ChatParticipant[];
  currentUserId?: string;
  onSelect: (p: ChatParticipant) => void;
}) {
  const [search, setSearch] = useState('');
  const list = participants.filter(
    (p) =>
      p.id !== currentUserId &&
      (!search || p.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="flex flex-col max-h-[320px]">
      <div className="p-2 border-b">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Mention someone..."
          autoFocus
          className="w-full h-[34px] px-2.5 text-sm rounded-md border border-input bg-background outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="overflow-y-auto p-1">
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No one to mention</p>
        ) : (
          list.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-left text-sm hover:bg-accent transition-colors"
            >
              <Avatar className="h-6 w-6 !rounded-[7px] flex-shrink-0">
                {p.avatar && <AvatarImage src={p.avatar} className="!rounded-[7px]" />}
                <AvatarFallback className="text-[10px] !rounded-[7px]">
                  {(p.name || '?')[0]?.toUpperCase() ?? '?'}
                </AvatarFallback>
              </Avatar>
              <span className="truncate flex-1">{p.name}</span>
              {p.isGuest && (
                <span className="ml-1 text-[10px] text-muted-foreground flex-shrink-0">Guest</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
