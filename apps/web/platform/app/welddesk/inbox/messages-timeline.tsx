import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { format, isSameDay } from 'date-fns';
import { ArrowDown, Bot, Lock, Paperclip } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DeskConversation, DeskMessage } from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';

interface MessagesTimelineProps {
  conversation: DeskConversation;
  messages: DeskMessage[];
  members: DeskWorkspaceMember[];
  /** Names of visitors currently typing. */
  typing: string[];
  onRetry: (message: DeskMessage) => void;
}

/** Consecutive messages from the same author inside this window share one header. */
const GROUP_WINDOW_MS = 5 * 60_000;
/** How close to the bottom still counts as "following the conversation". */
const STICK_THRESHOLD_PX = 120;

function memberLabel(members: DeskWorkspaceMember[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId)?.name ?? null;
}

function getAvatarColor(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function eventSentence(message: DeskMessage, members: DeskWorkspaceMember[]) {
  const t = getTranslations('deskInbox2');
  const actor = memberLabel(members, message.authorId) ?? t.timeline.unknownActor;
  const eventType = message.metadata?.eventType;
  if (eventType === 'closed') return t.timeline.closed.replace('{actor}', actor);
  if (eventType === 'reopened') return t.timeline.opened.replace('{actor}', actor);
  if (eventType === 'unassigned') return t.timeline.assignmentUnassigned.replace('{actor}', actor);
  if (eventType === 'assigned') {
    const target = memberLabel(members, message.metadata?.assigneeId ?? null) ?? message.metadata?.assigneeId ?? '';
    return t.timeline.assignmentToAdmin.replace('{actor}', actor).replace('{target}', target);
  }
  return message.body || t.timeline.genericEvent.replace('{actor}', actor).replace('{event}', eventType ?? 'event');
}

function sameGroup(a: DeskMessage | undefined, b: DeskMessage): boolean {
  if (!a || a.kind === 'event' || b.kind === 'event') return false;
  if (a.kind !== b.kind || a.authorType !== b.authorType || a.authorId !== b.authorId) return false;
  if (!isSameDay(new Date(a.createdAt), new Date(b.createdAt))) return false;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() < GROUP_WINDOW_MS;
}

function Avatar({ label, picture, isBot }: { label: string; picture?: string | null; isBot?: boolean }) {
  if (picture) {
    return <img src={picture} alt={label} className="w-7 h-7 rounded-full object-cover flex-shrink-0" />;
  }
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
      style={{ backgroundColor: getAvatarColor(label) }}
    >
      {isBot ? <Bot className="h-3.5 w-3.5" /> : label.slice(0, 1).toUpperCase()}
    </div>
  );
}

function DaySeparator({ date }: { date: Date }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="h-px flex-1 bg-border/70" />
      <span className="text-xs font-medium text-muted-foreground">{format(date, 'PPP')}</span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function TypingBubble({ names }: { names: string[] }) {
  const t = getTranslations('deskInbox2');
  return (
    <div className="flex items-end gap-2 px-4 pt-1 pb-2" data-testid="desk-inbox-typing">
      <div className="w-7 flex-shrink-0" />
      <div className="flex flex-col items-start gap-1">
        <div className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {t.pane.visitorTyping.replace('{name}', names[0])}
        </span>
      </div>
    </div>
  );
}

export function MessagesTimeline({ conversation, messages, members, typing, onRetry }: MessagesTimelineProps) {
  const t = getTranslations('deskInbox2');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const visitorLabel = conversation.name || conversation.email || t.pane.visitor;

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  // Opening a conversation lands on the latest message, instantly.
  useLayoutEffect(() => {
    stickRef.current = true;
    scrollToBottom('auto');
  }, [conversation.id, scrollToBottom]);

  // New content: follow along if the agent is at the bottom (or just sent
  // something); otherwise leave their scroll alone and offer a jump button.
  const last = messages[messages.length - 1];
  const lastKey = `${messages.length}:${last?.id ?? ''}:${last?.pending ?? ''}:${typing.length}`;
  useEffect(() => {
    const ownSend = last?.pending === 'sending';
    if (stickRef.current || ownSend) scrollToBottom('smooth');
    else setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stickRef.current = atBottom;
    if (atBottom) setShowJump(false);
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto py-2" data-testid="desk-inbox-timeline">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-16">{t.pane.partsEmpty}</p>
        )}
        {messages.map((message, index) => {
          const prev = messages[index - 1];
          const created = new Date(message.createdAt);
          const showDay = !prev || !isSameDay(new Date(prev.createdAt), created);

          if (message.kind === 'event') {
            return (
              <div key={message.clientId ?? message.id}>
                {showDay && <DaySeparator date={created} />}
                <p className="text-xs text-muted-foreground text-center py-2 px-4">
                  {eventSentence(message, members)} · {format(created, 'HH:mm')}
                </p>
              </div>
            );
          }

          const isVisitor = message.authorType === 'visitor';
          const isNote = message.kind === 'note';
          const isBot = message.authorType === 'bot';
          const member = members.find((m) => m.userId === message.authorId);
          const label = isVisitor
            ? visitorLabel
            : isBot
              ? t.pane.ai
              : member?.name ?? memberLabel(members, message.authorId) ?? 'Agent';
          const grouped = !showDay && sameGroup(prev, message);
          const next = messages[index + 1];
          const lastInGroup = !next || !sameGroup(message, next);

          return (
            <div key={message.clientId ?? message.id}>
              {showDay && <DaySeparator date={created} />}
              <div
                className={cn(
                  'flex items-end gap-2 px-4',
                  grouped ? 'pt-0.5' : 'pt-3',
                  isVisitor ? 'flex-row' : 'flex-row-reverse',
                )}
              >
                <div className="w-7 flex-shrink-0">
                  {lastInGroup && (
                    <Avatar label={label} picture={isVisitor ? null : member?.picture} isBot={isBot} />
                  )}
                </div>
                <div className={cn('flex flex-col max-w-[75%] min-w-0', isVisitor ? 'items-start' : 'items-end')}>
                  {!grouped && (
                    <div className={cn('flex items-center gap-1.5 mb-1 text-xs', isVisitor ? 'flex-row' : 'flex-row-reverse')}>
                      <span className="font-medium text-foreground truncate">{label}</span>
                      {isNote && (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                          <Lock className="h-3 w-3" />
                          {t.pane.internalNote}
                        </span>
                      )}
                      <span className="text-muted-foreground">{format(created, 'HH:mm')}</span>
                    </div>
                  )}
                  <div
                    title={format(created, 'PPpp')}
                    className={cn(
                      'rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words',
                      isVisitor && 'bg-muted text-foreground rounded-bl-md',
                      !isVisitor && !isNote && 'bg-primary text-primary-foreground rounded-br-md',
                      isNote &&
                        'bg-amber-50 text-amber-950 border border-amber-200 rounded-br-md dark:bg-amber-950/30 dark:text-amber-100 dark:border-amber-900',
                      message.pending === 'sending' && 'opacity-70',
                      message.pending === 'failed' && 'opacity-60 ring-1 ring-destructive/60',
                    )}
                  >
                    {message.body}
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {message.attachments.map((attachment) => (
                          <a
                            key={attachment.url}
                            href={attachment.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                          >
                            <Paperclip className="h-3 w-3" />
                            {attachment.name}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  {message.pending === 'sending' && (
                    <span className="mt-1 text-[11px] text-muted-foreground">{t.pane.sending}</span>
                  )}
                  {message.pending === 'failed' && (
                    <span className="mt-1 text-[11px] text-destructive">
                      {t.pane.notSent} ·{' '}
                      <button type="button" className="underline underline-offset-2" onClick={() => onRetry(message)}>
                        {t.pane.retry}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {typing.length > 0 && <TypingBubble names={typing} />}
        <div className="h-2" />
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {t.pane.newMessages}
        </button>
      )}
    </div>
  );
}
