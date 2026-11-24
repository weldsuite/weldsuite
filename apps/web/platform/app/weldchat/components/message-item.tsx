import { useRef, useState, useMemo, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAuth } from '@/lib/auth';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { MemberAvatar } from '@/components/member-avatar';
import { ReactionBar } from './reaction-bar';
import { MessageActions } from './message-actions';
import { MessageContextMenu } from './message-context-menu';
import { FilePreview } from './file-preview';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { Link as HrefLink } from '@/lib/router';
import {
  Pin,
  Phone,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Video,
  CornerUpRight,
  Hash,
  Lock,
  Bot,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useChatContext } from './chat-context';
import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { messagePreviewText, renderMessageContent, type InlineFileRenderer } from '../lib/render-message-content';
import { renderMessageBlocks } from '../lib/render-message-blocks';
import { MessageApprovals } from './message-approvals';
import { MessageVisuals } from './message-visuals';
import { MessageWeldMergeCard } from './message-weldmerge-card';
import { fileTokenIds } from '../lib/render-tokens';
import { isPinNotice, isSystemNotice, matchSystemNotice } from '../lib/system-notice';
import type { CallSummary } from '../lib/call-history';
import { getRecordChatTypeInfo } from '../lib/record-chat-types';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import type { ChatAttachment, ChatClipAttachment } from '@weldsuite/db/schema';

type MessageFile = ChatAttachment | ChatClipAttachment;
/** The attachment shape `FilePreview` reads (real rows always carry the full upload shape). */
type PreviewAttachment = { id: string; fileName: string; fileSize: number; mimeType: string; url: string; thumbnailUrl?: string };

const NO_FILES: MessageFile[] = [];

/** Whether a message mentions the user, by name or with @everyone. */
function mentionsUser(content: string | null | undefined, userId: string | null | undefined): boolean {
  if (!userId || !content) return false;
  return content.includes(`<@${userId}>`) || content.includes('<@everyone>');
}

/**
 * A message body rendered with the files its text places inline
 * (`<@file:id>`, an image pasted mid-sentence), plus the files it doesn't
 * place, for the gallery under the text. Memoised: parsing is not free, so it
 * runs once per content/attachments/member-map change, not on every row render.
 * `markdown` (agent messages) also renders lists, headings and paragraphs.
 */
function useMessageBody(
  content: string | null | undefined,
  attachments: MessageFile[],
  membersMap: Map<string, string> | undefined,
  channelId: string,
  messageId: string,
  markdown = false,
): { body: ReactNode; gallery: MessageFile[] } {
  return useMemo(() => {
    const byId = new Map(attachments.map((att) => [att.id, att]));
    const files: InlineFileRenderer = {
      render: (attachmentId, key) => {
        const att = byId.get(attachmentId);
        if (!att) return null;
        return (
          <span key={key} className="inline-block align-bottom max-w-full my-1 mr-1">
            <FilePreview attachment={att as unknown as PreviewAttachment} channelId={channelId} messageId={messageId} />
          </span>
        );
      },
    };
    const placed = new Set(content ? fileTokenIds(content) : []);
    const render = markdown ? renderMessageBlocks : renderMessageContent;
    return {
      body: content ? render(content, membersMap, files) : null,
      gallery: attachments.filter((att) => !placed.has(att.id)),
    };
  }, [content, attachments, membersMap, channelId, messageId, markdown]);
}

interface ReadByUser {
  userId: string;
  userName: string;
  userAvatar?: string;
}

interface ForwardedFromInfo {
  messageId: string;
  channelId: string;
  channelName: string;
  channelType: 'public' | 'private' | 'dm';
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  htmlContent?: string;
  createdAt: string;
  attachments?: Array<ChatAttachment | ChatClipAttachment>;
}

function forwardedChannelIcon(channelType: ForwardedFromInfo['channelType']): LucideIcon | null {
  if (channelType === 'private') return Lock;
  if (channelType === 'dm') return null;
  return Hash;
}

function ForwardedMessage({
  forwardedFrom,
  channelId,
  parentMessageId,
  membersMap,
}: Readonly<{
  forwardedFrom: ForwardedFromInfo;
  channelId: string;
  parentMessageId: string;
  membersMap?: Map<string, string>;
}>) {
  const { t } = useI18n();
  const ChannelIcon = forwardedChannelIcon(forwardedFrom.channelType);
  const { body: renderedForwarded, gallery: forwardedGallery } = useMessageBody(
    forwardedFrom.content,
    forwardedFrom.attachments ?? NO_FILES,
    membersMap,
    channelId,
    parentMessageId,
  );
  const sourceTime = new Date(forwardedFrom.createdAt).toLocaleString();

  return (
    <div className="mt-1.5 border-l-2 border-muted-foreground/25 pl-2.5 py-0.5">
      <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
        <CornerUpRight className="h-3 w-3" />
        <span>{t.weldchat.messageItem.forwardedFrom}</span>
        {ChannelIcon && <ChannelIcon className="h-3 w-3" />}
        <span className="font-medium">
          {forwardedFrom.channelType === 'dm' ? t.weldchat.messageItem.aDirectMessage : forwardedFrom.channelName}
        </span>
      </div>
      <div className="flex items-start gap-2">
        <MemberAvatar
          userId={forwardedFrom.authorId}
          name={forwardedFrom.authorName}
          picture={forwardedFrom.authorAvatar}
          className="h-5 w-5 flex-shrink-0 mt-0.5"
          fallbackClassName="text-[9px]"
          fallback={(forwardedFrom.authorName || '?')[0].toUpperCase()}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold">{forwardedFrom.authorName}</span>
            <span className="text-[11px] text-muted-foreground" title={sourceTime}>
              {sourceTime}
            </span>
          </div>
          <div className="text-sm whitespace-pre-wrap break-words">
            {renderedForwarded}
          </div>
          {forwardedGallery.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {forwardedGallery.map((att) => (
                <FilePreview
                  key={att.id}
                  attachment={att as unknown as PreviewAttachment}
                  channelId={channelId}
                  messageId={parentMessageId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Message row as this component reads it — the shared `ChatMessage` cache
 * shape, extended with the fields the index signature would otherwise widen
 * to `unknown` (agent authorship, edit/pin state, forwarding, channel name). */
export interface MessageItemMessage extends ChatMessage {
  authorType?: string;
  isEdited?: boolean;
  isPinned?: boolean;
  channelName?: string;
  forwardedFrom?: ForwardedFromInfo;
}

/** A real avatar image, as opposed to an agent's emoji icon. */
function isImageUrl(avatar: string | null | undefined): avatar is string {
  return !!avatar && /^(https?:|data:|blob:|\/)/.test(avatar);
}

/**
 * The line above a message that ties it to what it answers: a curved
 * connector, an optional 16px lead (the replied-to author's avatar) and a
 * short description. Replies and comments on a sheet, document or board share
 * it, so they read the same way.
 */
function ReferenceLine({
  lead,
  children,
  testId,
}: Readonly<{ lead?: ReactNode; children: ReactNode; testId?: string }>) {
  return (
    <div data-testid={testId} className="flex items-center gap-1.5 ml-[13px] mb-0.5 text-xs text-muted-foreground">
      <div className="w-[22px] h-3 shrink-0 border-l-2 border-t-2 border-muted-foreground/40 rounded-tl-md" />
      <div className="flex min-w-0 items-center gap-1.5 -translate-y-[4px]">
        {lead}
        {children}
      </div>
    </div>
  );
}

/**
 * "Comment on {place}" with the place in bold, like the author's name on a
 * reply. With `href` it is a link to the record (the board, sheet or document)
 * in its own app.
 */
/** When a thread's last reply came in: the time today, else the day ("21:45", "20 Nov"). */
function lastReplyLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * "N replies · 21:45" under a message, hooked to it by a curved line: opens
 * its thread in the side panel beside the conversation (`onOpen`), or
 * without `onOpen` goes to the thread's own page.
 */
function ThreadIndicator({
  channelId,
  messageId,
  onOpen,
  lastReplyAt,
  children,
}: Readonly<{
  channelId: string;
  messageId: string;
  onOpen?: () => void;
  /** When the last reply came in, shown after the count. */
  lastReplyAt?: string | null;
  children: ReactNode;
}>) {
  const last = lastReplyLabel(lastReplyAt);
  // The count sits between message text (14px) and a timestamp (12px); the
  // time is small, like a message's.
  const className = 'group/thread mt-1 flex w-fit items-center gap-1.5 text-[13px]';
  const content = (
    <>
      {/* The line from the message down to its replies. */}
      <span
        aria-hidden
        className="-mt-2 h-3 w-3.5 shrink-0 rounded-bl-[7px] border-b-[1.5px] border-l-[1.5px] border-muted-foreground/40 transition-colors group-hover/thread:border-muted-foreground/70"
      />
      <span className="font-medium text-primary group-hover/thread:underline">{children}</span>
      {last && (
        <span className="text-xs text-muted-foreground" title={formatFullTime(lastReplyAt ?? undefined)}>
          · {last}
        </span>
      )}
    </>
  );
  if (onOpen) {
    return (
      <button type="button" data-testid="chat-thread-indicator" onClick={onOpen} className={className}>
        {content}
      </button>
    );
  }
  return (
    <Link
      data-testid="chat-thread-indicator"
      to="/weldchat/$channelId/thread/$messageId"
      params={{ channelId, messageId }}
      className={className}
    >
      {content}
    </Link>
  );
}

function CommentPlaceText({ template, place, href }: Readonly<{ template: string; place: string; href?: string }>) {
  const [before = '', after = ''] = template.split('{place}');
  const text = (
    <>
      {before}
      <span className="font-semibold text-foreground/70 group-hover/comment:text-foreground">{place}</span>
      {after}
    </>
  );
  if (!href) return <span className="truncate max-w-[420px]">{text}</span>;
  return (
    <HrefLink
      href={href}
      data-testid="chat-message-comment-link"
      className="group/comment truncate max-w-[420px] rounded-sm hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
    >
      {text}
    </HrefLink>
  );
}

/** Minimal shape needed to render the "replying to" reference line. */
interface ReplyToMessagePreview {
  authorId?: string | null;
  authorAvatar?: string | null;
  authorName?: string;
  content?: string;
}

interface MessageItemProps {
  message: MessageItemMessage;
  compact?: boolean;
  showChannel?: boolean;
  channelId?: string;
  /** Map of userId → display name for resolving mention badges */
  membersMap?: Map<string, string>;
  /** The parent message being replied to */
  replyToMessage?: ReplyToMessagePreview;
  /** Users who have read this message */
  readBy?: ReadByUser[];
  /** Whether this message is the start of the call that is live in this channel */
  hasActiveCall?: boolean;
  /** The id of that live call, so its notice can offer Join */
  activeCallId?: string;
  /** The call this notice stands for (its start and end folded into one row), when it is a call notice */
  call?: CallSummary;
  /** The record this chat belongs to (a board, sheet or document), for its comment threads */
  record?: CommentRecord;
}

/** The record a record chat belongs to: its type ('board', 'sheet', …) and current title. */
export interface CommentRecord {
  type: string;
  /** The record's id, to link to it; absent when unknown. */
  id?: string;
  title: string;
}

/** Where a record opens in its own app (`/weldboard/<id>`), if it has a page. */
function recordHref(record: CommentRecord | undefined): string | undefined {
  if (!record?.id) return undefined;
  return getRecordChatTypeInfo(record.type)?.href?.(record.id);
}

/**
 * Where a comment thread's first message is in its record, from
 * `metadata.anchor` (ADR CHAT-007): the cell ("Sheet1!B7"), the text it is
 * about, or the board element. A comment on the board itself has no label and
 * shows the board's title. Null for any other message.
 *
 * `legacyBoardLabel`: the board's own "On the board" placeholder, which board
 * comments were saved with before; it is shown as the title too. Read only
 * for a board's chat.
 */
function commentPlace(message: MessageItemMessage, record: CommentRecord | undefined, legacyBoardLabel: () => string): string | null {
  const anchor = (message.metadata as { anchor?: { label?: unknown; quote?: unknown } } | null | undefined)?.anchor;
  if (!anchor || message.parentId) return null;
  const label = typeof anchor.label === 'string' ? anchor.label : '';
  const isBoardPlaceholder = record?.type === 'board' && label === legacyBoardLabel();
  if (label && !isBoardPlaceholder) return label;
  if (typeof anchor.quote === 'string' && anchor.quote) return `“${anchor.quote}”`;
  return record?.title || label || null;
}

function shortTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFullTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** Derives the icon of a non-call system message from its text. */
function systemIcon(lowerText: string): LucideIcon | null {
  if (lowerText.includes('pinned')) return Pin;
  if (lowerText.includes('video call')) return Video;
  if (lowerText.includes('call')) return Phone;
  return null;
}

/**
 * Room above a message, call or pin that starts a group (avatar and name),
 * so one person's group stands apart from the next; rows inside a group sit
 * close (`pt-0.5`).
 */
const GROUP_START_PADDING = 'pt-3.5';

/** A message's author name. Hovering the avatar underlines it too: both open the same profile. */
const AUTHOR_NAME_CLASS =
  'h-auto px-0 py-0 font-semibold text-sm hover:underline group-has-[[data-author-avatar]:hover]/message:underline focus:outline-none focus-visible:underline hover:bg-transparent';

type CallRowState = 'live' | 'started' | 'answered' | 'noAnswer' | 'declined' | 'missed';

/**
 * A WeldChat call rings until someone picks up and ends when nobody does or
 * it is declined (as on WhatsApp, not Discord, where the caller waits in the
 * call): an unanswered call never ran. The caller sees there was no answer;
 * the people it rang, that they missed it.
 */
function callRowState(call: CallSummary, isLive: boolean, isMine: boolean): CallRowState {
  if (isLive) return 'live';
  if (!call.outcome) return 'started';
  if (call.outcome === 'answered') return 'answered';
  if (call.outcome === 'declined') return 'declined';
  return isMine ? 'noAnswer' : 'missed';
}

/** Green phone for a call that ran, grey for one that didn't connect, red for a missed one. */
const CALL_ICON_COLOR: Record<CallRowState, string> = {
  live: 'text-green-600 dark:text-green-400',
  started: 'text-green-600 dark:text-green-400',
  answered: 'text-green-600 dark:text-green-400',
  noAnswer: 'text-muted-foreground',
  declined: 'text-muted-foreground',
  missed: 'text-red-600 dark:text-red-400',
};

function callRowIcon(state: CallRowState): LucideIcon {
  if (state === 'missed') return PhoneMissed;
  if (state === 'declined') return PhoneOff;
  if (state === 'noAnswer') return PhoneOutgoing;
  return Phone;
}

type CallHistoryStrings = ReturnType<typeof useI18n>['t']['weldchat']['callHistory'];
type FormatFn = ReturnType<typeof useI18n>['format'];

/** How long a call took in seconds: talk time, else from its start to its end. */
function callSeconds(call: CallSummary): number | undefined {
  if (call.duration) return call.duration;
  if (call.endOnly || !call.startedAt || !call.endedAt) return call.duration;
  const ms = Date.parse(call.endedAt) - Date.parse(call.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : call.duration;
}

/** "a few seconds", "a minute", "12 minutes", "an hour", "3 hours". */
function lastedText(tc: CallHistoryStrings, format: FormatFn, seconds: number): string {
  if (seconds < 45) return tc.lastedSeconds;
  if (seconds < 90) return tc.lastedMinute;
  const minutes = Math.round(seconds / 60);
  if (minutes < 45) return format(tc.lastedMinutes, { count: minutes });
  if (minutes < 90) return tc.lastedHour;
  return format(tc.lastedHours, { count: Math.round(minutes / 60) });
}

/** The line under the caller's name, with `{duration}` in it. */
function callRowTemplate(tc: CallHistoryStrings, state: CallRowState, isMine: boolean, lasted: boolean): string {
  switch (state) {
    case 'answered':
      return lasted ? tc.startedCallLasted : tc.startedCall;
    case 'noAnswer':
      return tc.calledNoAnswer;
    case 'declined':
      return isMine ? tc.calledDeclined : tc.declinedCall;
    case 'missed':
      return tc.missedCall;
    default:
      return tc.startedCall;
  }
}

/**
 * A notice drawn like a message from the person it is about (the caller, who
 * pinned): their avatar, name and the time, and under it one line with an
 * icon. Notices and messages from the same person close together share one
 * header (`compact`), as messages do.
 */
function NoticeRow({
  message,
  authorId,
  authorName,
  compact,
  icon: Icon,
  iconClassName,
  children,
  ...rowProps
}: Readonly<
  Omit<ComponentProps<'div'>, 'className'> & {
    message: MessageItemMessage;
    authorId?: string | null;
    authorName: string;
    compact?: boolean;
    icon: LucideIcon;
    iconClassName?: string;
  }
>) {
  const { openUserProfile } = useChatContext();
  // Posted under that person; drawn as them, never as a workflow.
  const author: MessageItemMessage = { ...message, authorType: 'user', authorId: authorId ?? undefined, authorName };
  const openAuthor = () => {
    if (authorId) openUserProfile(authorId);
  };

  return (
    <div
      data-message-id={message.id}
      {...rowProps}
      className={cn(
        'group group/message relative border-l-2 border-l-transparent px-2 pb-0.5 transition-colors hover:bg-muted/50 md:px-4',
        compact ? 'pt-0.5' : GROUP_START_PADDING,
      )}
    >
      <div className="flex items-start gap-2 md:gap-3">
        <MessageAvatar message={author} compact={compact} onAuthorClick={openAuthor} />
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={openAuthor} className={AUTHOR_NAME_CLASS}>
                {authorName}
              </Button>
              <span className="text-xs text-muted-foreground" title={formatFullTime(message.createdAt ?? undefined)}>
                {shortTime(message.createdAt ?? undefined)}
              </span>
            </div>
          )}
          <p className="flex min-h-5 flex-wrap items-center gap-x-1.5 text-sm text-foreground">
            <Icon aria-hidden className={cn('size-[15px] shrink-0', iconClassName)} />
            {children}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * One call in the conversation, as a message from the caller, with how the
 * call went under their name ("You missed the call."). Only a call that ran
 * says how long it lasted; a live call you are not in offers Join call.
 */
function CallNoticeRow({
  message,
  call,
  compact,
  isLive,
  liveCallId,
}: Readonly<{
  message: MessageItemMessage;
  call: CallSummary;
  compact?: boolean;
  isLive: boolean;
  /** The live call's id, for Join call. */
  liveCallId?: string;
}>) {
  const { t, format } = useI18n();
  const { userId } = useAuth();
  const callContext = useWeldChatCallOptional();
  const tc = t.weldchat.callHistory;
  const isMine = !!userId && call.initiatorId === userId;
  const state = callRowState(call, isLive, isMine);
  const seconds = state === 'answered' ? callSeconds(call) : undefined;
  const text = format(callRowTemplate(tc, state, isMine, seconds !== undefined), {
    duration: seconds === undefined ? '' : lastedText(tc, format, seconds),
  });
  const canJoin = state === 'live' && !!liveCallId && !!callContext && callContext.callId !== liveCallId;

  return (
    <NoticeRow
      message={message}
      authorId={call.initiatorId ?? message.authorId}
      authorName={call.initiatorName || message.authorName || t.weldchat.callRoom.participant}
      compact={compact}
      icon={callRowIcon(state)}
      iconClassName={CALL_ICON_COLOR[state]}
      data-testid="chat-call-notice"
      data-call-state={state}
    >
      <span>{text}</span>
      {canJoin && (
        <Button
          type="button"
          variant="link"
          onClick={() => callContext.joinCall(liveCallId)}
          className="h-auto p-0 text-sm"
        >
          {tc.joinCall}
        </Button>
      )}
    </NoticeRow>
  );
}

/** Scroll to a message in the list and flash it (a pin notice's link to what was pinned). */
function jumpToMessage(messageId: string) {
  const el = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('pinned-highlight');
  setTimeout(() => el.classList.remove('pinned-highlight'), 1000);
}

/** "Pinned a message." under the name of who pinned it; the line jumps to that message. */
function PinNoticeRow({
  message,
  pinnedMessageId,
  compact,
}: Readonly<{ message: MessageItemMessage; pinnedMessageId?: string; compact?: boolean }>) {
  const { t } = useI18n();
  const label = t.weldchat.messageItem.pinnedMessage;
  return (
    <NoticeRow
      message={message}
      authorId={message.authorId}
      authorName={message.authorName || t.weldchat.callRoom.participant}
      compact={compact}
      icon={Pin}
      iconClassName="text-muted-foreground"
      data-testid="chat-pin-notice"
    >
      {pinnedMessageId ? (
        <button type="button" onClick={() => jumpToMessage(pinnedMessageId)} className="text-left hover:underline">
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </NoticeRow>
  );
}

function SystemMessage({
  message,
  systemMatch,
}: Readonly<{
  message: MessageItemMessage;
  systemMatch: RegExpMatchArray | null;
}>) {
  const linkedMessageId = systemMatch?.[1];
  const labelText = systemMatch
    ? `${message.authorName} ${systemMatch[2]}`
    : message.content;

  const handleSystemClick = () => {
    if (linkedMessageId) jumpToMessage(linkedMessageId);
  };

  const SystemIcon = systemIcon(labelText?.toLowerCase() || '');

  const chipClassName = cn(
    'inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1 text-muted-foreground bg-muted/70 dark:bg-muted/50',
    linkedMessageId && 'cursor-pointer hover:bg-muted',
  );
  const time = shortTime(message.createdAt ?? undefined);
  const chipContent = (
    <>
      {SystemIcon && <SystemIcon className="h-3 w-3 flex-shrink-0" />}
      {labelText}
      {time && (
        <>
          <span aria-hidden className="text-muted-foreground/50">·</span>
          <time dateTime={message.createdAt ?? undefined} title={formatFullTime(message.createdAt ?? undefined)} className="tabular-nums">{time}</time>
        </>
      )}
    </>
  );

  return (
    <div data-message-id={message.id} className="flex justify-center py-1.5 px-2 md:px-4">
      {linkedMessageId ? (
        <button type="button" onClick={handleSystemClick} className={chipClassName}>
          {chipContent}
        </button>
      ) : (
        <span className={chipClassName}>{chipContent}</span>
      )}
    </div>
  );
}

function MessageAvatar({
  message,
  compact,
  onAuthorClick,
}: Readonly<{
  message: MessageItemMessage;
  compact?: boolean;
  onAuthorClick: () => void;
}>) {
  const { t } = useI18n();

  if (compact) {
    return (
      <div className="w-7 flex-shrink-0 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
          {new Date(message.createdAt ?? '').toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
    );
  }

  if (message.authorType === 'agent') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onAuthorClick}
        style={{ marginTop: '3px' }}
        className="h-7 w-7 p-0 flex-shrink-0 rounded-[9px] bg-muted flex items-center justify-center text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
        title={`${message.authorName} ${t.weldchat.messageItem.agentClickDetails}`}
      >
        {message.authorAvatar || <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
      </Button>
    );
  }

  // A WeldConnect workflow step (post_chat_message) — never clickable (there is
  // no teammate/agent profile behind it), just a workflow icon + its name.
  if (message.authorType === 'system') {
    return (
      <div
        style={{ marginTop: '3px' }}
        className="h-7 w-7 flex-shrink-0 rounded-[9px] bg-muted flex items-center justify-center"
        title={`${message.authorName} ${t.weldchat.messageItem.workflowClickDetails}`}
      >
        <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onAuthorClick}
      style={{ marginTop: '3px' }}
      data-author-avatar
      className="h-7 w-7 p-0 flex-shrink-0 rounded-[9px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80 transition-opacity"
      title={t.weldchat.messageItem.viewProfile.replace('{name}', message.authorName ?? '')}
    >
      <MemberAvatar
        userId={message.authorId}
        name={message.authorName}
        picture={message.authorAvatar}
        className="h-7 w-7"
        fallbackClassName="text-[9px]"
        fallback={(message.authorName || '?')[0].toUpperCase()}
      />
    </Button>
  );
}

export function MessageItem({
  message,
  compact,
  showChannel,
  channelId,
  membersMap,
  replyToMessage,
  readBy,
  hasActiveCall,
  activeCallId,
  call,
  record,
}: Readonly<MessageItemProps>) {
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { userId } = useAuth();
  const { t, format } = useI18n();
  const { openUserProfile, openAgentProfile, openThread } = useChatContext();
  const place = commentPlace(message, record, () => t.weldboard.editor.comments.onBoard);
  const resolvedChannelId = channelId || message.channelId || '';
  // The cache-side `ChatAttachment` models only the fields cache-merge helpers
  // touch (all optional); real rows always carry the full upload shape.
  const messageFiles = (message.attachments as unknown as MessageFile[] | undefined) ?? NO_FILES;
  const { body: renderedContent, gallery } = useMessageBody(
    message.content,
    messageFiles,
    membersMap,
    resolvedChannelId,
    message.id,
    // Agents answer in markdown; people type plain text.
    message.authorType === 'agent',
  );
  const isMentioned = mentionsUser(message.content, userId);
  const handleAuthorClick = () => {
    if (!message.authorId) return;
    // A workflow-posted message (authorId "workflow:<id>") has no profile
    // behind it — nothing to open.
    if (message.authorType === 'system') return;
    // Agent replies open the agent profile panel; human replies open the
    // teammate profile panel (same UX, different data source).
    if (message.authorType === 'agent') {
      openAgentProfile(message.authorId);
    } else {
      openUserProfile(message.authorId);
    }
  };

  // The `[system…]` prefix is only honoured on real system messages (and the
  // legacy pin notice), so a member can't type a fake notice.
  if (isSystemNotice(message)) {
    if (call) {
      return (
        <CallNoticeRow
          message={message}
          call={call}
          compact={compact}
          isLive={!!hasActiveCall}
          liveCallId={activeCallId}
        />
      );
    }
    const systemMatch = matchSystemNotice(message);
    if (isPinNotice(message)) {
      return <PinNoticeRow message={message} pinnedMessageId={systemMatch?.[1]} compact={compact} />;
    }
    return <SystemMessage message={message} systemMatch={systemMatch} />;
  }

  const timeStr = new Date(message.createdAt ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fullTime = new Date(message.createdAt ?? '').toLocaleString();

  return (
    <MessageContextMenu message={message} channelId={resolvedChannelId} readBy={readBy}>
    <div
      ref={rowRef}
      data-message-id={message.id}
      data-testid="chat-message"
      className={cn(
        // Always reserve the 2px left border so the mention highlight only
        // changes color, not layout — otherwise mentioned messages would
        // shift relative to surrounding messages and the text "jumps".
        // Rows touch, so their hover areas join up: a message that starts a
        // group carries the space above it, one under it in a group sits close.
        'group group/message relative px-2 md:px-4 pb-0.5 hover:bg-muted/50 transition-colors border-l-2 border-l-transparent',
        compact ? 'pt-0.5' : GROUP_START_PADDING,
        isMentioned && 'bg-yellow-50/60 dark:bg-yellow-900/10 border-l-yellow-400 dark:border-l-yellow-500',
        message._optimistic && 'opacity-60',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!menuOpen) setIsHovered(false); }}
    >
      {/* Reply reference */}
      {replyToMessage && (
        <ReferenceLine
          lead={
            replyToMessage.authorAvatar && !isImageUrl(replyToMessage.authorAvatar) ? (
              // An agent's avatar is its emoji icon, not an image.
              <Avatar className="h-4 w-4">
                <AvatarFallback className="text-[8px]">{replyToMessage.authorAvatar}</AvatarFallback>
              </Avatar>
            ) : (
              <MemberAvatar
                userId={replyToMessage.authorId}
                name={replyToMessage.authorName}
                picture={replyToMessage.authorAvatar}
                className="h-4 w-4"
                fallbackClassName="text-[8px]"
                fallback={(replyToMessage.authorName || '?')[0]}
              />
            )
          }
        >
          <span className="font-semibold text-foreground/70">{replyToMessage.authorName}</span>
          <span className="truncate max-w-[300px]">{messagePreviewText(replyToMessage.content ?? '', membersMap)}</span>
        </ReferenceLine>
      )}
      {/* The comment thread this message starts, on a sheet, a document or a
          board: drawn like a reply. */}
      {place && (
        <ReferenceLine testId="chat-message-comment-place">
          <CommentPlaceText template={t.weldchat.messageItem.commentOn} place={place} href={recordHref(record)} />
        </ReferenceLine>
      )}
      <div className="flex items-start gap-2 md:gap-3">
      {/* Avatar or spacer */}
      <MessageAvatar message={message} compact={compact} onAuthorClick={handleAuthorClick} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {!compact && (
          <div className="flex items-center gap-2">
            {message.authorType === 'system' ? (
              <span className="font-semibold text-sm">{message.authorName}</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={handleAuthorClick}
                className={AUTHOR_NAME_CLASS}
              >
                {message.authorName}
              </Button>
            )}
            {message.authorType === 'agent' && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1 font-normal">{t.weldchat.memberList.agentBadge}</Badge>
            )}
            {message.authorType === 'system' && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1 font-normal">{t.weldchat.messageItem.workflowBadge}</Badge>
            )}
            <span className="text-xs text-muted-foreground" title={fullTime}>
              {timeStr}
            </span>
            {message.isEdited && (
              <span className="text-xs text-muted-foreground">{t.weldchat.messageItem.edited}</span>
            )}
            {showChannel && message.channelName && (
              <span className="text-xs text-muted-foreground">
                {format(t.weldchat.messageItem.inChannel, { name: message.channelName })}
              </span>
            )}
          </div>
        )}
        {message.content && (
          (() => {
            // Agent placeholder content still in-flight — anything ending in "…"
            // authored by an agent. Render with a pulse + three animated dots
            // so the user sees it's still working.
            const isAgentThinking =
              message.authorType === 'agent' && /…\s*$/.test(String(message.content));
            if (isAgentThinking) {
              const stripped = String(message.content).replace(/…\s*$/, '').trim();
              return (
                <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                  {stripped && <span>{stripped}</span>}
                  <span className="inline-flex gap-0.5" aria-label={t.weldchat.messageItem.agentThinking}>
                    <span className="h-1 w-1 rounded-full bg-current [animation:weldchat-bounce_1s_ease-in-out_infinite]" />
                    <span className="h-1 w-1 rounded-full bg-current [animation:weldchat-bounce_1s_ease-in-out_0.15s_infinite]" />
                    <span className="h-1 w-1 rounded-full bg-current [animation:weldchat-bounce_1s_ease-in-out_0.3s_infinite]" />
                  </span>
                </div>
              );
            }
            return (
              <div data-testid="chat-message-content" className="text-sm whitespace-pre-wrap break-words">
                {renderedContent}
              </div>
            );
          })()
        )}

        {/* Charts, figures, tables and record cards the agent showed */}
        <MessageVisuals message={message} />

        {/* Actions the agent is waiting on a person to approve */}
        <MessageApprovals message={message} />

        {/* A WeldMerge update (or an item shared with /merge) as a card */}
        <MessageWeldMergeCard message={message} />

        {/* Forwarded message snapshot */}
        {message.forwardedFrom && (
          <ForwardedMessage
            forwardedFrom={message.forwardedFrom}
            channelId={resolvedChannelId}
            parentMessageId={message.id}
            membersMap={membersMap}
          />
        )}

        {/* Attachments the text doesn't place inline */}
        {gallery.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {gallery.map((att) => (
              <FilePreview key={att.id} attachment={att as unknown as PreviewAttachment} channelId={resolvedChannelId} messageId={message.id} />
            ))}
          </div>
        )}

        {/* Reactions */}
        {message.reactions &&
          Object.keys(message.reactions).length > 0 && (
            <ReactionBar
              reactions={message.reactions}
              messageId={message.id}
              channelId={resolvedChannelId}
            />
          )}

        {(message.threadReplyCount ?? 0) > 0 && (
          <ThreadIndicator
            channelId={resolvedChannelId}
            messageId={message.id}
            // A list across channels has no channel open to show it beside:
            // there it goes to the thread's page.
            onOpen={showChannel ? undefined : () => openThread(message.id)}
            lastReplyAt={message.threadLastReplyAt ?? message.lastReplyAt}
          >
            {message.threadReplyCount}{' '}
            {message.threadReplyCount === 1 ? t.weldchat.messageItem.reply : t.weldchat.messageItem.replies}
          </ThreadIndicator>
        )}

      </div>

      </div>

      {/* Hover actions */}
      {(isHovered || menuOpen) && (
        <MessageActions
          message={message}
          channelId={resolvedChannelId}
          readBy={readBy}
          onOpenChange={(open) => {
            setMenuOpen(open);
            // A menu closed: keep the bar while the pointer is still on the
            // message (the emoji button clicked again to close its menu), hide
            // it when the pointer is elsewhere (a reaction picked in the
            // menu, which hangs outside the row).
            if (!open) setIsHovered(rowRef.current?.matches(':hover') ?? false);
          }}
        />
      )}
    </div>
    </MessageContextMenu>
  );
}
