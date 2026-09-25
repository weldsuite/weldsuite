import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronLeft, Loader2, Mail, Paperclip, X } from 'lucide-react';
import type { ThreadMessage, WidgetConfigResponse } from '@/lib/api/types';
import { DRAFT_ID, type Messenger } from '@/hooks/use-messenger';
import { cn } from '@/lib/utils/cn';
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

function eventText(message: ThreadMessage): string {
  if (message.eventType === 'closed') return 'Conversation closed';
  if (message.eventType === 'reopened') return 'Conversation reopened';
  if (message.eventType === 'assigned') return 'A teammate joined the conversation';
  return message.body || '';
}

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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
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

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    stickRef.current = true;
    const id = await messenger.send(conversationId, body);
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

            {messages.map((message, index) => {
              if (message.kind === 'event') {
                const text = eventText(message);
                return text ? (
                  <p key={message.clientId ?? message.id} className="px-6 py-2 text-center text-xs text-gray-400">
                    {text}
                  </p>
                ) : null;
              }
              const mine = message.authorType === 'visitor';
              const prev = messages[index - 1];
              const next = messages[index + 1];
              const grouped = groupedWith(prev, message);
              const lastInGroup = !groupedWith(message, next);
              const author = message.authorName ?? 'Support';

              return (
                <div
                  key={message.clientId ?? message.id}
                  className={cn('flex items-end gap-2 px-4', grouped ? 'pt-0.5' : 'pt-3', mine && 'justify-end')}
                >
                  {!mine && (
                    <div className="w-7 flex-shrink-0">
                      {lastInGroup && <Avatar name={author} src={message.authorAvatar} size={28} />}
                    </div>
                  )}
                  <div className={cn('flex flex-col max-w-[78%] min-w-0', mine ? 'items-end' : 'items-start')}>
                    {!mine && !grouped && <span className="mb-1 ml-1 text-[11px] text-gray-500">{author}</span>}
                    <div
                      className={cn(
                        'rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words',
                        mine ? 'rounded-br-md' : 'rounded-bl-md bg-gray-100 text-gray-900',
                        message.status === 'sending' && 'opacity-70',
                        message.status === 'failed' && 'opacity-60',
                      )}
                      style={mine ? { backgroundColor: color, color: onColor } : undefined}
                      title={new Date(message.createdAt).toLocaleString()}
                    >
                      {message.body}
                      {message.attachments?.map((attachment) => (
                        <a
                          key={attachment.url}
                          href={attachment.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 flex items-center gap-1 text-xs underline underline-offset-2"
                        >
                          <Paperclip className="h-3 w-3" />
                          {attachment.name}
                        </a>
                      ))}
                    </div>
                    {message.status === 'failed' ? (
                      <button
                        type="button"
                        onClick={() => void retry(message)}
                        className="mt-1 text-[11px] text-red-500 hover:underline"
                      >
                        Not sent · Tap to retry
                      </button>
                    ) : (
                      lastInGroup && (
                        <span className="mt-1 mx-1 text-[11px] text-gray-400">
                          {message.status === 'sending' ? 'Sending…' : clockTime(message.createdAt)}
                        </span>
                      )
                    )}
                  </div>
                </div>
              );
            })}

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
        <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white pl-3.5 pr-1.5 py-1.5 focus-within:border-gray-300 focus-within:shadow-sm transition">
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
            disabled={!draft.trim()}
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
