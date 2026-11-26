import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, Loader2, Paperclip, Plus, X } from 'lucide-react';
import type { MessageAttachment, ThreadMessage, WidgetConfigResponse } from '@/lib/api/types';
import { DRAFT_ID, type Messenger } from '@/hooks/use-messenger';
import { useAvailability } from '@/hooks/use-availability';
import { useArticleSuggestions } from '@/hooks/use-self-service';
import { fill, t } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';
import {
  ATTACHMENT_ACCEPT,
  MAX_MESSAGE_ATTACHMENTS,
  attachmentProblem,
  isImageAttachment,
} from '@/lib/utils/attachments';
import { MessageAttachments } from './message-attachments';
import { Avatar, AvatarStack, TypingDots, readableOn } from './parts';
import { EmailCapture } from './email-capture';
import { RatingCard } from './rating-card';
import { AwayNotice, replyTimeText } from './away-notice';
import { ArticleSuggestions } from './article-suggestions';
import { LinkifiedText } from './linkified-text';

interface ConversationViewProps {
  config: WidgetConfigResponse;
  messenger: Messenger;
  conversationId: string;
  /** Called when a draft becomes a real conversation. */
  onCreated: (id: string) => void;
  onBack: () => void;
  onClose?: () => void;
  isOpen: boolean;
}

const GROUP_WINDOW_MS = 5 * 60_000;
const STICK_THRESHOLD_PX = 100;

function groupedWith(a: ThreadMessage | undefined, b: ThreadMessage | undefined): boolean {
  if (!a || !b || a.kind === 'event' || b.kind === 'event') return false;
  if (a.authorType !== b.authorType) return false;
  if (a.authorType === 'agent' && a.authorName !== b.authorName) return false;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() < GROUP_WINDOW_MS;
}

interface MessageRowProps {
  message: ThreadMessage;
  prev: ThreadMessage | undefined;
  next: ThreadMessage | undefined;
  color: string;
  onColor: string;
  /** The conversation's rating, for the "You rated…" line of a `rated` event. */
  rating: number | null;
  onRetry: (message: ThreadMessage) => void;
}

function MessageStatus({
  message,
  lastInGroup,
  onRetry,
}: Readonly<{ message: ThreadMessage; lastInGroup: boolean; onRetry: (message: ThreadMessage) => void }>) {
  if (message.status === 'failed') {
    return (
      <button type="button" onClick={() => onRetry(message)} className="mt-1 text-[11px] text-red-500 hover:underline">
        Not sent · Tap to retry
      </button>
    );
  }
  if (!lastInGroup || message.status !== 'sending') return null;
  return <span className="mt-1 mx-1 text-[11px] text-gray-400">Sending…</span>;
}

/**
 * An event (a teammate joined, closed, reopened, rated) as a divider across the
 * thread: a line, the event, a line, with 20px above and below. Below is 8px
 * here plus the 12px whatever comes next (message, card, another event) starts
 * with; an event right after an event takes only 12px on top so the two sit
 * 20px apart too.
 */
function EventDivider({
  message,
  prev,
  rating,
}: Readonly<{ message: ThreadMessage; prev: ThreadMessage | undefined; rating: number | null }>) {
  const text = eventText(message, rating);
  if (!text) return null;
  return (
    <div className={cn('flex items-center gap-3 px-4 pb-2', prev?.kind === 'event' ? 'pt-3' : 'pt-5')}>
      <span aria-hidden="true" className="h-px flex-1 bg-gray-200" />
      <p className="max-w-[75%] text-center text-xs text-gray-500">{text}</p>
      <span aria-hidden="true" className="h-px flex-1 bg-gray-200" />
    </div>
  );
}

function MessageRow({ message, prev, next, color, onColor, rating, onRetry }: Readonly<MessageRowProps>) {
  if (message.kind === 'event') return <EventDivider message={message} prev={prev} rating={rating} />;
  const mine = message.authorType === 'visitor';
  const grouped = groupedWith(prev, message);
  const lastInGroup = !groupedWith(message, next);
  const author = message.authorName ?? 'Support';
  const attachments = message.attachments ?? [];
  // Pictures on their own don't need a coloured bubble around them.
  const mediaOnly =
    !message.body && attachments.length > 0 && attachments.every((a) => isImageAttachment(a.contentType));
  // A message sent right after the one above it joins it: the corner where they meet is sharp too.
  let bubble = cn('px-3.5 py-2.5 rounded-bl-md bg-gray-100 text-gray-900', grouped && 'rounded-tl-md');
  if (mediaOnly) bubble = '';
  else if (mine) bubble = cn('px-3.5 py-2.5 rounded-br-md', grouped && 'rounded-tr-md');

  return (
    <div className={cn('flex items-end px-4', grouped ? 'pt-0.5' : 'pt-3', mine && 'justify-end')}>
      <div className={cn('flex flex-col max-w-[78%] min-w-0', mine ? 'items-end' : 'items-start')}>
        {/* No avatar or name on screen: screen readers still hear who wrote it. */}
        {!mine && !grouped && <span className="sr-only">{author}:</span>}
        <div
          className={cn(
            'text-sm whitespace-pre-wrap break-words rounded-2xl',
            bubble,
            message.status === 'sending' && 'opacity-70',
            message.status === 'failed' && 'opacity-60',
          )}
          style={mine && !mediaOnly ? { backgroundColor: color, color: onColor } : undefined}
          title={new Date(message.createdAt).toLocaleString()}
        >
          {message.body && <LinkifiedText text={message.body} />}
          {attachments.length > 0 && (
            <MessageAttachments attachments={attachments} className={message.body ? 'mt-2' : undefined} />
          )}
        </div>
        <MessageStatus message={message} lastInGroup={lastInGroup} onRetry={onRetry} />
      </div>
    </div>
  );
}

function eventText(message: ThreadMessage, rating: number | null): string {
  if (message.eventType === 'closed') return 'Conversation closed';
  if (message.eventType === 'reopened') return 'Conversation reopened';
  if (message.eventType === 'assigned') return 'A teammate joined the conversation';
  if (message.eventType === 'rated') return rating ? fill(t.rating.rated, { rating }) : '';
  return message.body || '';
}

/** A file the visitor picked: uploading, ready to send with the next message, or failed. */
interface PendingFile {
  key: string;
  name: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: MessageAttachment;
  error?: string;
}

let pendingCounter = 0;

export function ConversationView({
  config,
  messenger,
  conversationId,
  onCreated,
  onBack,
  onClose,
  isOpen,
}: Readonly<ConversationViewProps>) {
  const color = config.branding.primaryColor;
  const onColor = readableOn(color);
  const isDraft = conversationId === DRAFT_ID;
  const conversation = messenger.conversations.find((c) => c.id === conversationId) ?? null;
  const messages = messenger.threads[conversationId] ?? [];
  const loading = messenger.loadingThread === conversationId && messages.length === 0;
  const agentTyping = messenger.typing[conversationId] ?? null;
  const assignee = conversation?.assignee ?? null;
  const title = assignee?.name ?? config.name ?? 'Support';
  const { away, nextOpenAt } = useAvailability(config);
  const rating = conversation?.rating ?? null;
  let subtitle = replyTimeText(config) ?? 'The team will reply as soon as they can';
  if (away) subtitle = t.away.title;
  if (agentTyping) subtitle = `${agentTyping} is typing…`;

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // The reply field floats over the bottom of the thread, so the thread keeps
  // that much room free below its last message.
  const composerRef = useRef<HTMLFormElement>(null);
  const [composerHeight, setComposerHeight] = useState(58);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
  }, []);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setComposerHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A taller reply field (a second line, attachments, suggestions) mustn't cover the newest message.
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom('auto');
  }, [composerHeight, scrollToBottom]);

  useLayoutEffect(() => {
    scrollToBottom('auto');
  }, [conversationId, loading, scrollToBottom]);

  const lastKey = `${messages.length}:${messages[messages.length - 1]?.id ?? ''}:${agentTyping ?? ''}`;
  useEffect(() => {
    if (stickRef.current) scrollToBottom('smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen, conversationId]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  // Files can only be uploaded into a conversation that exists already.
  const canAttach = !isDraft;
  const readyAttachments = pending.flatMap((p) => (p.status === 'ready' && p.attachment ? [p.attachment] : []));
  const uploading = pending.some((p) => p.status === 'uploading');
  const canSend = !uploading && (draft.trim().length > 0 || readyAttachments.length > 0);

  // A pending file belongs to the conversation it was uploaded into.
  useEffect(() => {
    setPending([]);
  }, [conversationId]);

  const addFiles = (files: FileList | null) => {
    if (!files || !canAttach) return;
    const room = MAX_MESSAGE_ATTACHMENTS - pending.length;
    const entries: PendingFile[] = [];
    const uploads: Array<{ key: string; file: File }> = [];
    Array.from(files).forEach((file, index) => {
      pendingCounter += 1;
      const key = `f${pendingCounter}`;
      const problem =
        index >= room ? `You can attach up to ${MAX_MESSAGE_ATTACHMENTS} files` : attachmentProblem(file);
      if (problem) {
        entries.push({ key, name: file.name, status: 'error', error: problem });
      } else {
        entries.push({ key, name: file.name, status: 'uploading' });
        uploads.push({ key, file });
      }
    });
    setPending((prev) => [...prev, ...entries]);
    for (const { key, file } of uploads) {
      messenger
        .uploadAttachment(conversationId, file)
        .then((attachment) =>
          setPending((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'ready', attachment } : p))),
        )
        .catch((err: unknown) =>
          setPending((prev) =>
            prev.map((p) =>
              p.key === key
                ? { ...p, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
                : p,
            ),
          ),
        );
    }
  };

  const removePending = (key: string) => setPending((prev) => prev.filter((p) => p.key !== key));

  const submit = async () => {
    if (!canSend) return;
    const body = draft.trim();
    const attachments = readyAttachments;
    setDraft('');
    setPending([]);
    stickRef.current = true;
    const id = await messenger.send(conversationId, body, { attachments });
    // A new conversation, or one the team merged: the message landed elsewhere.
    if (id && (isDraft || id !== conversationId)) onCreated(id);
  };

  const retry = async (message: ThreadMessage) => {
    const id = await messenger.retry(conversationId, message);
    if (id && (isDraft || id !== conversationId)) onCreated(id);
  };

  const hasVisitorMessage = messages.some((m) => m.authorType === 'visitor' && m.status !== 'failed');
  // Deflection: only while the first message of a new conversation is being
  // written. Once anything is sent, the suggestions get out of the way.
  const suggestions = useArticleSuggestions(config.widgetId, draft, isDraft && messages.length === 0);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col" data-testid="chat-view">
      <header className="flex items-center gap-2 px-2 h-16 flex-shrink-0 border-b border-gray-100 bg-white text-gray-900">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          data-testid="back-button"
          className="rounded-xl p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {assignee ? (
          <Avatar name={assignee.name} src={assignee.avatar} size={32} />
        ) : (
          <AvatarStack team={config.team} size={28} />
        )}
        <div className="min-w-0 flex-1 pl-1">
          <p className="text-[15px] font-semibold truncate leading-tight">{title}</p>
          <p className="text-xs text-gray-500 truncate" data-testid="chat-subtitle">
            {subtitle}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="close-button"
            className="rounded-xl p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
        }}
        className="widget-scrollbar flex-1 min-h-0 overflow-y-auto pt-3"
        style={{ paddingBottom: composerHeight + 12 }}
        data-testid="message-list"
      >
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : (
          <>
            {/* Greeting bubble so an empty thread never looks dead. */}
            <div className="flex items-end px-4 pb-1">
              <div className="max-w-[78%] rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-2.5 text-sm text-gray-900 whitespace-pre-wrap break-words">
                {config.greeting}
              </div>
            </div>

            {away && <AwayNotice config={config} nextOpenAt={nextOpenAt} className="px-4 pt-3" />}

            {messages.map((message, index) => (
              <MessageRow
                key={message.clientId ?? message.id}
                message={message}
                prev={messages[index - 1]}
                next={messages[index + 1]}
                color={color}
                onColor={onColor}
                rating={rating}
                onRetry={(m) => void retry(m)}
              />
            ))}

            {agentTyping && (
              <div className="flex items-end px-4 pt-3" data-testid="typing-indicator">
                <div className="rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-3">
                  <TypingDots />
                </div>
              </div>
            )}

            {(hasVisitorMessage || away) && <EmailCapture messenger={messenger} color={color} away={away} />}

            {conversation?.state === 'closed' && (
              <>
                <RatingCard
                  color={color}
                  rating={conversation.rating ?? null}
                  onSubmit={(rating, comment) => messenger.rate(conversation.id, rating, comment)}
                />
                <p className="px-4 pt-2 text-center text-xs text-gray-400">
                  This conversation was closed. Send a message to reopen it.
                </p>
              </>
            )}
          </>
        )}
      </div>

      <form
        ref={composerRef}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="absolute inset-x-0 bottom-0 px-3 pb-3"
        // Messages show around the field's top corners only: white below it and
        // around its bottom corners (12px padding + 23px corner radius).
        style={{ background: 'linear-gradient(to top, #ffffff 35px, transparent 35px)' }}
      >
        <ArticleSuggestions hits={suggestions} color={color} />
        {pending.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="pending-attachments">
            {pending.map((file) => (
              <li
                key={file.key}
                title={file.error}
                className={cn(
                  'flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-1 text-xs',
                  file.status === 'error'
                    ? 'border-red-300 bg-red-50 text-red-600'
                    : 'border-gray-200 bg-gray-50 text-gray-700',
                )}
              >
                {file.status === 'uploading' ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                ) : (
                  <Paperclip className="h-3 w-3 flex-shrink-0" />
                )}
                <span className="min-w-0 max-w-[140px] truncate">
                  {file.status === 'error' ? file.error : file.name}
                </span>
                <button
                  type="button"
                  onClick={() => removePending(file.key)}
                  aria-label={`Remove ${file.name}`}
                  className="rounded-full p-0.5 hover:bg-black/10"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1 rounded-[23px] bg-gray-100 py-[7px] pl-5 pr-[7px]">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value.trim()) messenger.notifyTyping();
              else messenger.stopTyping();
            }}
            onBlur={() => messenger.stopTyping()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={isDraft ? 'Ask a question…' : 'Write a reply…'}
            aria-label="Message"
            data-testid="message-input"
            className="flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-gray-900 outline-none focus-visible:outline-none placeholder:text-gray-400 max-h-[120px]"
          />
          {canAttach && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                data-testid="file-input"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={pending.length >= MAX_MESSAGE_ATTACHMENTS}
                aria-label="Attach a file"
                data-testid="attach-button"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 disabled:opacity-40"
              >
                <Plus className="h-5 w-5" />
              </button>
            </>
          )}
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            data-testid="send-button"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:bg-gray-200 disabled:text-gray-400"
            style={canSend ? { backgroundColor: color, color: onColor } : undefined}
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </form>
    </div>
  );
}
