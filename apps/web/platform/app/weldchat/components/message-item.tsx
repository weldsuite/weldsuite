import { useState, useEffect, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useAuth } from '@clerk/clerk-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { ReactionBar } from './reaction-bar';
import { MessageActions } from './message-actions';
import { MessageContextMenu } from './message-context-menu';
import { FilePreview } from './file-preview';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import {
  MessageSquare,
  Pin,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Video,
  VideoOff,
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
import { messagePreviewText, renderMessageContent } from '../lib/render-message-content';
import { isSystemNotice, matchSystemNotice } from '../lib/system-notice';
import { formatCallDuration, type CallSummary } from '../lib/call-history';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import type { ChatAttachment, ChatClipAttachment } from '@weldsuite/db/schema';

/** Live timer that counts up from a start time */
function LiveCallTimer({ startedAt }: Readonly<{ startedAt: string }>) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const time = h > 0
    ? `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`
    : `${m}m ${s.toString().padStart(2, '0')}s`;

  return <span className="font-mono tabular-nums">&mdash; {time}</span>;
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
  const renderedForwarded = useMemo(
    () => renderMessageContent(forwardedFrom.content, membersMap),
    [forwardedFrom.content, membersMap],
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
        <Avatar className="h-5 w-5 !rounded-[6px] flex-shrink-0 mt-0.5">
          {forwardedFrom.authorAvatar && (
            <AvatarImage src={forwardedFrom.authorAvatar} className="!rounded-[6px]" />
          )}
          <AvatarFallback className="text-[9px] !rounded-[6px]">
            {(forwardedFrom.authorName || '?')[0].toUpperCase()}
          </AvatarFallback>
        </Avatar>
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
          {forwardedFrom.attachments && forwardedFrom.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {forwardedFrom.attachments.map((att) => (
                <FilePreview
                  key={att.id}
                  attachment={att as unknown as { id: string; fileName: string; fileSize: number; mimeType: string; url: string; thumbnailUrl?: string }}
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

/** Minimal shape needed to render the "replying to" reference line. */
interface ReplyToMessagePreview {
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
  /** Whether this is a DM conversation */
  isDm?: boolean;
  /** Whether this message is the start of the call that is live in this channel */
  hasActiveCall?: boolean;
  /** The call this notice stands for (its start and end folded into one row), when it is a call notice */
  call?: CallSummary;
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

type CallRowState = 'live' | 'started' | 'answered' | 'noAnswer' | 'missed' | 'declined';

function callRowState(call: CallSummary, isLive: boolean, isMine: boolean): CallRowState {
  if (isLive) return 'live';
  if (!call.outcome) return 'started';
  if (call.outcome === 'answered') return 'answered';
  if (call.outcome === 'declined') return 'declined';
  // An unanswered call is only "missed" for the people it rang.
  return isMine ? 'noAnswer' : 'missed';
}

const CALL_ROW_STYLE: Record<CallRowState, { icon: string; status: string; chip?: string }> = {
  live: {
    icon: 'bg-green-500/15 text-green-600 dark:text-green-400',
    status: 'text-green-700 dark:text-green-400',
    chip: 'text-green-700 dark:text-green-400 bg-green-500/10 dark:bg-green-500/5',
  },
  started: { icon: 'bg-muted-foreground/10 text-muted-foreground', status: 'text-muted-foreground' },
  answered: { icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', status: 'text-emerald-700 dark:text-emerald-400' },
  noAnswer: { icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', status: 'text-amber-700 dark:text-amber-400' },
  declined: { icon: 'bg-red-500/15 text-red-600 dark:text-red-400', status: 'text-red-600 dark:text-red-400' },
  missed: {
    icon: 'bg-red-500/15 text-red-600 dark:text-red-400',
    status: 'text-red-600 dark:text-red-400',
    chip: 'text-red-700 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10',
  },
};

function callRowIcon(state: CallRowState, isVideo: boolean, isMine: boolean): LucideIcon {
  if (state === 'missed') return isVideo ? VideoOff : PhoneMissed;
  if (state === 'declined') return isVideo ? VideoOff : PhoneOff;
  if (isVideo) return Video;
  if (state === 'answered' || state === 'noAnswer') return isMine ? PhoneOutgoing : PhoneIncoming;
  return Phone;
}

type CallHistoryStrings = ReturnType<typeof useI18n>['t']['weldchat']['callHistory'];
type FormatFn = ReturnType<typeof useI18n>['format'];

function callRowTitle(
  tc: CallHistoryStrings,
  format: FormatFn,
  call: CallSummary,
  state: CallRowState,
  isMine: boolean,
): string {
  const isVideo = call.callType === 'video';
  const name = call.initiatorName ?? '';
  if (state === 'missed') {
    if (call.endOnly) return tc.missedCall;
    return format(isVideo ? tc.missedVideoFrom : tc.missedVoiceFrom, { name });
  }
  if (call.endOnly) return tc.callEnded;
  if (isMine) return isVideo ? tc.youStartedVideo : tc.youStartedVoice;
  return format(isVideo ? tc.startedVideo : tc.startedVoice, { name });
}

function callRowStatus(tc: CallHistoryStrings, call: CallSummary, state: CallRowState): string | null {
  if (state === 'answered') return call.duration ? formatCallDuration(call.duration) : tc.ended;
  if (state === 'noAnswer') return tc.noAnswer;
  if (state === 'declined') return tc.declined;
  return null;
}

function callRowTooltip(tc: CallHistoryStrings, format: FormatFn, call: CallSummary): string {
  const lines: string[] = [];
  if (call.startedAt && !call.endOnly) lines.push(format(tc.startedAt, { time: formatFullTime(call.startedAt) }));
  if (call.endedAt) lines.push(format(tc.endedAt, { time: formatFullTime(call.endedAt) }));
  return lines.join('\n');
}

/** One call in the conversation: who started it, how it went, how long it took, and when. */
function CallNoticeRow({
  message,
  call,
  isLive,
}: Readonly<{ message: MessageItemMessage; call: CallSummary; isLive: boolean }>) {
  const { t, format } = useI18n();
  const { userId } = useAuth();
  const tc = t.weldchat.callHistory;
  const isMine = !!userId && call.initiatorId === userId;
  const state = callRowState(call, isLive, isMine);
  const style = CALL_ROW_STYLE[state];
  const Icon = callRowIcon(state, call.callType === 'video', isMine);
  const title = callRowTitle(tc, format, call, state, isMine);
  const status = callRowStatus(tc, call, state);
  const tooltip = callRowTooltip(tc, format, call);

  return (
    <div data-message-id={message.id} data-testid="chat-call-notice" data-call-state={state} className="flex justify-center py-1.5 px-2 md:px-4">
      <span
        title={tooltip || undefined}
        className={cn(
          'inline-flex items-center gap-2 text-xs rounded-md pl-1.5 pr-3 py-1',
          style.chip ?? 'text-muted-foreground bg-muted/70 dark:bg-muted/50',
        )}
      >
        <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full', style.icon)}>
          <Icon className="h-3 w-3" {...(state === 'live' ? { fill: 'currentColor' } : {})} />
        </span>
        <span className={cn('font-medium', !style.chip && 'text-foreground/80')}>{title}</span>
        {state === 'live' && (
          <span className={cn('inline-flex items-center gap-1', style.status)}>
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden />
            {tc.live}
            <LiveCallTimer startedAt={call.startedAt ?? message.createdAt ?? ''} />
          </span>
        )}
        {status && (
          <>
            <span aria-hidden className="text-muted-foreground/50">·</span>
            <span className={cn('font-medium tabular-nums', style.status)}>{status}</span>
          </>
        )}
        {call.startedAt && (
          <>
            <span aria-hidden className="text-muted-foreground/50">·</span>
            <time dateTime={call.startedAt} className="tabular-nums text-muted-foreground">{shortTime(call.startedAt)}</time>
          </>
        )}
      </span>
    </div>
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
    if (!linkedMessageId) return;
    const el = document.querySelector(`[data-message-id="${linkedMessageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pinned-highlight');
      setTimeout(() => el.classList.remove('pinned-highlight'), 1000);
    }
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
      <Avatar className="h-7 w-7 !rounded-[9px]">
        {message.authorAvatar && (
          <AvatarImage src={message.authorAvatar} className="!rounded-[9px]" />
        )}
        <AvatarFallback className="text-[9px] !rounded-[9px]">
          {(message.authorName || '?')[0].toUpperCase()}
        </AvatarFallback>
      </Avatar>
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
  call,
}: Readonly<MessageItemProps>) {
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { userId } = useAuth();
  const { t, format } = useI18n();
  const { openUserProfile, openAgentProfile } = useChatContext();
  // Parsing is not free: render each body once per content/member-map change, not on every row render (hover, menu, …).
  const renderedContent = useMemo(
    () => (message.content ? renderMessageContent(message.content, membersMap) : null),
    [message.content, membersMap],
  );
  const isMentioned =
    userId &&
    (message.content?.includes(`<@${userId}>`) ||
      message.content?.includes('<@everyone>'));
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
    if (call) return <CallNoticeRow message={message} call={call} isLive={!!hasActiveCall} />;
    return <SystemMessage message={message} systemMatch={matchSystemNotice(message)} />;
  }

  const timeStr = new Date(message.createdAt ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fullTime = new Date(message.createdAt ?? '').toLocaleString();
  const resolvedChannelId = channelId || message.channelId || '';

  return (
    <MessageContextMenu message={message} channelId={resolvedChannelId} readBy={readBy}>
    <div
      data-message-id={message.id}
      data-testid="chat-message"
      className={cn(
        // Always reserve the 2px left border so the mention highlight only
        // changes color, not layout — otherwise mentioned messages would
        // shift relative to surrounding messages and the text "jumps".
        'group group/message relative px-2 md:px-4 py-1 hover:bg-muted/50 transition-colors border-l-2 border-l-transparent',
        compact && 'py-0.5',
        isMentioned && 'bg-yellow-50/60 dark:bg-yellow-900/10 border-l-yellow-400 dark:border-l-yellow-500',
        message._optimistic && 'opacity-60',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!menuOpen) setIsHovered(false); }}
    >
      {/* Reply reference */}
      {replyToMessage && (
        <div className="flex items-center gap-1.5 ml-[13px] mb-0.5 text-xs text-muted-foreground">
          <div className="w-[22px] h-3 border-l-2 border-t-2 border-muted-foreground/40 rounded-tl-md" />
          <div className="flex items-center gap-1.5 -translate-y-[4px]">
            <Avatar className="h-4 w-4 !rounded-[5.5px]">
              {replyToMessage.authorAvatar && <AvatarImage src={replyToMessage.authorAvatar} className="!rounded-[5.5px]" />}
              <AvatarFallback className="text-[8px] !rounded-[5.5px]">{(replyToMessage.authorName || '?')[0]}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-foreground/70">{replyToMessage.authorName}</span>
            <span className="truncate max-w-[300px]">{messagePreviewText(replyToMessage.content ?? '', membersMap)}</span>
          </div>
        </div>
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
                // Hovering the avatar underlines the name too: both open the same profile.
                className="h-auto px-0 py-0 font-semibold text-sm hover:underline group-has-[[data-author-avatar]:hover]/message:underline focus:outline-none focus-visible:underline hover:bg-transparent"
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

        {/* Forwarded message snapshot */}
        {message.forwardedFrom && (
          <ForwardedMessage
            forwardedFrom={message.forwardedFrom}
            channelId={resolvedChannelId}
            parentMessageId={message.id}
            membersMap={membersMap}
          />
        )}

        {/* Attachments */}
        {(message.attachments?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {/* The cache-side `ChatAttachment` models only the fields cache-merge
                helpers touch (all optional); real rows always carry the full
                upload shape `FilePreview` expects. */}
            {(message.attachments as unknown as Array<ChatAttachment | ChatClipAttachment>).map((att) => (
              <FilePreview key={att.id} attachment={att as unknown as { id: string; fileName: string; fileSize: number; mimeType: string; url: string; thumbnailUrl?: string }} channelId={resolvedChannelId} messageId={message.id} />
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

        {/* Thread indicator */}
        {(message.threadReplyCount ?? 0) > 0 && (
          <Link
            data-testid="chat-thread-indicator"
            to="/weldchat/$channelId/thread/$messageId"
            params={{
              channelId: resolvedChannelId,
              messageId: message.id,
            }}
            className="flex items-center gap-1 mt-1 text-xs text-primary hover:underline"
          >
            <MessageSquare className="h-3 w-3" />
            {message.threadReplyCount}{' '}
            {message.threadReplyCount === 1 ? t.weldchat.messageItem.reply : t.weldchat.messageItem.replies}
          </Link>
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
            if (!open) setIsHovered(false);
          }}
        />
      )}
    </div>
    </MessageContextMenu>
  );
}
