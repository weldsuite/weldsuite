import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, Loader2, Mail, Paperclip, X } from 'lucide-react';
import type { MessageAttachment, ThreadMessage, WidgetConfigResponse } from '@/lib/api/types';
import { DRAFT_ID, type Messenger } from '@/hooks/use-messenger';
import { cn } from '@/lib/utils/cn';
import {
  ATTACHMENT_ACCEPT,
  MAX_MESSAGE_ATTACHMENTS,
  attachmentProblem,
  isImageAttachment,
} from '@/lib/utils/attachments';
import { MessageAttachments } from './message-attachments';
import { Avatar, AvatarStack, TypingDots, clockTime, readableOn } from './parts';

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
  if (!lastInGroup) return null;
  return (
    <span className="mt-1 mx-1 text-[11px] text-gray-400">
      {message.status === 'sending' ? 'Sending…' : clockTime(message.createdAt)}
    </span>
  );
}

function MessageRow({ message, prev, next, color, onColor, onRetry }: Readonly<MessageRowProps>) {
  if (message.kind === 'event') {
    const text = eventText(message);
    return text ? <p className="px-6 py-2 text-center text-xs text-gray-400">{text}</p> : null;
  }
  const mine = message.authorType === 'visitor';
  const grouped = groupedWith(prev, message);
  const lastInGroup = !groupedWith(message, next);
  const author = message.authorName ?? 'Support';
  const attachments = message.attachments ?? [];
  // Pictures on their own don't need a coloured bubble around them.
  const mediaOnly =
    !message.body && attachments.length > 0 && attachments.every((a) => isImageAttachment(a.contentType));
  let bubble = 'px-3.5 py-2.5 rounded-bl-md bg-gray-100 text-gray-900';
  if (mediaOnly) bubble = '';
  else if (mine) bubble = 'px-3.5 py-2.5 rounded-br-md';

  return (
    <div className={cn('flex items-end gap-2 px-4', grouped ? 'pt-0.5' : 'pt-3', mine && 'justify-end')}>
      {!mine && (
        <div className="w-7 flex-shrink-0">
          {lastInGroup && <Avatar name={author} src={message.authorAvatar} size={28} />}
        </div>
      )}
      <div className={cn('flex flex-col max-w-[78%] min-w-0', mine ? 'items-end' : 'items-start')}>
        {!mine && !grouped && <span className="mb-1 ml-1 text-[11px] text-gray-500">{author}</span>}
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
          {message.body}
          {attachments.length > 0 && (
            <MessageAttachments attachments={attachments} className={message.body ? 'mt-2' : undefined} />
          )}
        </div>
        <MessageStatus message={message} lastInGroup={lastInGroup} onRetry={onRetry} />
      </div>
    </div>
  );
}

function eventText(message: ThreadMessage): string {
  if (message.eventType === 'closed') return 'Conversation closed';
  if (message.eventType === 'reopened') return 'Conversation reopened';
  if (message.eventType === 'assigned') return 'A teammate joined the conversation';
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

function EmailCapture({ messenger, color }: Readonly<{ messenger: Messenger; color: string }>) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');

  if (messenger.profile.email) {
    return (
      <div className="mx-4 my-2 flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600">
        <Mail className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">
          You&apos;ll be notified at <span className="font-medium text-gray-900">{messenger.profile.email}</span>
        </span>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) {
      setState('error');
      return;
    }
    setState('saving');
    try {
      await messenger.identify(value);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <form onSubmit={submit} className="mx-4 my-2 rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm" data-testid="email-capture">
      <p className="text-[13px] font-semibold text-gray-900">Get notified by email</p>
      <p className="text-xs text-gray-500 mt-0.5">We&apos;ll email you when we reply, in case you&apos;ve left.</p>
      <div className="mt-2.5 flex items-center gap-2">
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === 'error') setState('idle');
          }}
          placeholder="you@example.com"
          className={cn(
            'min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:outline-none focus:border-gray-400',
            state === 'error' ? 'border-red-400' : 'border-gray-200',
          )}
        />
        <button
          type="submit"
          disabled={state === 'saving'}
          className="rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60"
          style={{ backgroundColor: color, color: readableOn(color) }}
        >
          {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
      </div>
      {state === 'error' && <p className="mt-1.5 text-xs text-red-500">Please enter a valid email address.</p>}
    </form>
  );
}

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

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
  }, []);

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
    if (isDraft && id) onCreated(id);
  };

  const retry = async (message: ThreadMessage) => {
    const id = await messenger.retry(conversationId, message);
    if (isDraft && id) onCreated(id);
  };

  const hasVisitorMessage = messages.some((m) => m.authorType === 'visitor' && m.status !== 'failed');

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="chat-view">
      <header
        className="flex items-center gap-2 px-2 h-16 flex-shrink-0"
        style={{ backgroundColor: color, color: onColor }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          data-testid="back-button"
          className="rounded-full p-1.5 opacity-90 hover:opacity-100 hover:bg-white/15 transition"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {assignee ? (
          <Avatar name={assignee.name} src={assignee.avatar} size={34} />
        ) : (
          <AvatarStack team={config.team} size={30} ring={color} />
        )}
        <div className="min-w-0 flex-1 pl-1">
          <p className="text-[15px] font-semibold truncate leading-tight">{title}</p>
          <p className="text-xs opacity-80 truncate">
            {agentTyping ? `${agentTyping} is typing…` : 'The team will reply as soon as they can'}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="close-button"
            className="rounded-full p-1.5 opacity-90 hover:opacity-100 hover:bg-white/15 transition"
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
        className="flex-1 min-h-0 overflow-y-auto py-3"
        data-testid="message-list"
      >
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : (
          <>
            {/* Greeting bubble so an empty thread never looks dead. */}
            <div className="flex items-end gap-2 px-4 pb-1">
              <Avatar name={config.team[0]?.name ?? 'Support'} src={config.team[0]?.avatar} size={28} />
              <div className="max-w-[78%] rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-2.5 text-sm text-gray-900 whitespace-pre-wrap break-words">
                {config.greeting}
              </div>
            </div>

            {messages.map((message, index) => (
              <MessageRow
                key={message.clientId ?? message.id}
                message={message}
                prev={messages[index - 1]}
                next={messages[index + 1]}
                color={color}
                onColor={onColor}
                onRetry={(m) => void retry(m)}
              />
            ))}

            {agentTyping && (
              <div className="flex items-end gap-2 px-4 pt-3" data-testid="typing-indicator">
                <Avatar name={agentTyping} src={assignee?.avatar} size={28} />
                <div className="rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-3">
                  <TypingDots />
                </div>
              </div>
            )}

            {hasVisitorMessage && <EmailCapture messenger={messenger} color={color} />}
          </>
        )}
      </div>

      {conversation?.state === 'closed' && (
        <p className="px-4 pt-2 text-center text-xs text-gray-400">
          This conversation was closed. Send a message to reopen it.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex-shrink-0 p-3"
      >
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
        <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white pl-1.5 pr-1.5 py-1.5 focus-within:border-gray-300 focus-within:shadow-sm transition">
          {canAttach ? (
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
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            </>
          ) : (
            <span className="w-2" aria-hidden="true" />
          )}
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
            className="flex-1 resize-none bg-transparent py-1.5 text-sm text-gray-900 outline-none focus-visible:outline-none placeholder:text-gray-400 max-h-[120px]"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            data-testid="send-button"
            className="flex h-8 w-8 items-center justify-center rounded-full transition disabled:opacity-30"
            style={{ backgroundColor: color, color: onColor }}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
