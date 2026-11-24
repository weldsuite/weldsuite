import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { format, isSameDay } from 'date-fns';
import { ArrowDown, Bot, Lock, Paperclip } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type {
  DeskAttributeChange,
  DeskConversation,
  DeskMessage,
  DeskMessageAttachment,
  DeskPriority,
  DeskSlaMetric,
} from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';
import { Avatar as UiAvatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { formatFileSize } from './attachments';
import { MessageTranslation } from './translation/message-translation';
import { LinkifiedText } from './linkified-text';
import { impactUrgencySentences, isLinkEvent, linkEventSentence } from './linked-timeline';
import { isServiceRequestEvent, serviceRequestEventSentence } from './service-request-timeline';
import { isProblemEvent, problemEventSentence } from './problem-timeline';
import { escalationSentence } from './escalation-label';
import { isPhoneTimelineMessage, PhoneTimelineRow } from './phone-timeline';

interface MessagesTimelineProps {
  conversation: DeskConversation;
  messages: DeskMessage[];
  members: DeskWorkspaceMember[];
  /** Names of visitors currently typing. */
  typing: string[];
  onRetry: (message: DeskMessage) => void;
}

/** How close to the bottom still counts as "following the conversation". */
const STICK_THRESHOLD_PX = 120;

/** Images as thumbnails, other files as links with their size. */
function AttachmentList({
  attachments,
  spaced,
}: Readonly<{ attachments: DeskMessageAttachment[] | null; spaced: boolean }>) {
  if (!attachments?.length) return null;
  return (
    <div className={cn('flex flex-col gap-1', spaced && 'mt-2')}>
      {attachments.map((attachment) =>
        attachment.contentType.startsWith('image/') ? (
          <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer" title={attachment.name}>
            <img
              src={attachment.url}
              alt={attachment.name}
              loading="lazy"
              className="max-h-48 max-w-full rounded-lg object-cover"
            />
          </a>
        ) : (
          <a
            key={attachment.url}
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
          >
            <Paperclip className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{attachment.name}</span>
            <span className="opacity-70 no-underline">· {formatFileSize(attachment.filesize)}</span>
          </a>
        ),
      )}
    </div>
  );
}

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
    hash = name.codePointAt(i)! + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function displayValue(value: unknown, t: ReturnType<typeof getTranslations<'deskInbox2'>>): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value === true) return t.ticket.yes;
  if (value === false) return t.ticket.no;
  return String(value);
}

type Fill = (template: string, value?: unknown, field?: string) => string;

function isEmptyChange(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** "added x, y" and "removed z" lines for a tag list change. */
function tagSentences(change: DeskAttributeChange, fill: Fill, t: ReturnType<typeof getTranslations<'deskInbox2'>>): string[] {
  const before = Array.isArray(change.from) ? (change.from as string[]) : [];
  const after = Array.isArray(change.to) ? (change.to as string[]) : [];
  const added = after.filter((tag) => !before.includes(tag));
  const removed = before.filter((tag) => !after.includes(tag));
  const lines: string[] = [];
  if (added.length) lines.push(fill(t.timeline.tagsAdded, added));
  if (removed.length) lines.push(fill(t.timeline.tagsRemoved, removed));
  return lines;
}

function changeSentences(change: DeskAttributeChange, fill: Fill, t: ReturnType<typeof getTranslations<'deskInbox2'>>): string[] {
  const cleared = isEmptyChange(change.to);
  switch (change.field) {
    case 'ticketType':
      return [cleared ? fill(t.timeline.typeCleared) : fill(t.timeline.typeSet, change.to)];
    case 'team':
      return [cleared ? fill(t.timeline.teamCleared) : fill(t.timeline.teamSet, change.to)];
    case 'priority': {
      const priority = change.to as DeskPriority | null;
      return [priority ? fill(t.timeline.prioritySet, t.ticket.priorities[priority] ?? priority) : fill(t.timeline.priorityCleared)];
    }
    case 'tags':
      return tagSentences(change, fill, t);
    case 'impact':
    case 'urgency':
      return impactUrgencySentences(change, fill);
    case 'customField': {
      const field = change.label ?? change.key;
      return [cleared ? fill(t.timeline.fieldCleared, undefined, field) : fill(t.timeline.fieldSet, change.to, field)];
    }
    default:
      return [];
  }
}

/** One line per ticket field an `attributes_changed` event changed. */
function attributeSentences(message: DeskMessage, actor: string): string[] {
  const t = getTranslations('deskInbox2');
  const fill: Fill = (template, value, field) =>
    template
      .replace('{actor}', actor)
      .replace('{value}', value === undefined ? '' : displayValue(value, t))
      .replace('{field}', field ?? '');
  return (message.metadata?.changes ?? []).flatMap((change) => changeSentences(change, fill, t));
}

function eventSentence(message: DeskMessage, members: DeskWorkspaceMember[], visitorLabel: string) {
  const t = getTranslations('deskInbox2');
  const eventType = message.metadata?.eventType;
  if (eventType === 'rated') {
    const rating = t.timeline.ratingLabel.replace('{rating}', String(message.metadata?.rating ?? '?'));
    return t.timeline.ratingChanged.replace('{actor}', visitorLabel).replace('{rating}', rating);
  }
  const actor = memberLabel(members, message.authorId) ?? t.timeline.unknownActor;
  if (eventType === 'closed') return t.timeline.closed.replace('{actor}', actor);
  if (eventType === 'reopened') return t.timeline.opened.replace('{actor}', actor);
  if (eventType === 'unassigned') return t.timeline.assignmentUnassigned.replace('{actor}', actor);
  if (eventType === 'escalated') return escalationSentence(message.metadata, (id) => memberLabel(members, id));
  if (eventType === 'sla_warning' || eventType === 'sla_breached') {
    const metric = message.metadata?.metric as DeskSlaMetric | undefined;
    const label = (metric && t.sla.metrics[metric]) || 'SLA';
    return (eventType === 'sla_warning' ? t.timeline.slaWarning : t.timeline.slaBreached).replace('{metric}', label);
  }
  if (eventType === 'assigned') {
    const target = memberLabel(members, message.metadata?.assigneeId ?? null) ?? message.metadata?.assigneeId ?? '';
    if (message.metadata?.auto) return t.timeline.autoAssigned.replace('{target}', target);
    return t.timeline.assignmentToAdmin.replace('{actor}', actor).replace('{target}', target);
  }
  const linked =
    linkEventSentence(message, actor) ??
    problemEventSentence(message, actor) ??
    serviceRequestEventSentence(message, actor, (id) => memberLabel(members, id));
  if (linked) return linked;
  return message.body || t.timeline.genericEvent.replace('{actor}', actor).replace('{event}', eventType ?? 'event');
}

/** Who wrote a message: the customer, the AI, or the teammate by name. */
function authorLabel(message: DeskMessage, members: DeskWorkspaceMember[], visitorLabel: string): string {
  if (message.authorType === 'visitor') return visitorLabel;
  if (message.authorType === 'bot') return getTranslations('deskInbox2').pane.ai;
  const member = members.find((m) => m.userId === message.authorId);
  return member?.name ?? memberLabel(members, message.authorId) ?? 'Agent';
}

/** A state change on the timeline; a rating also shows the visitor's comment under it. */
function EventRow({
  message,
  members,
  visitorLabel,
}: Readonly<{ message: DeskMessage; members: DeskWorkspaceMember[]; visitorLabel: string }>) {
  const comment = message.metadata?.eventType === 'rated' ? message.metadata.ratingComment : null;
  if (message.metadata?.eventType === 'attributes_changed') {
    const actor = memberLabel(members, message.authorId) ?? getTranslations('deskInbox2').timeline.unknownActor;
    const time = format(new Date(message.createdAt), 'HH:mm');
    return (
      <div className="py-2 px-4" data-testid="desk-inbox-attributes-event">
        {attributeSentences(message, actor).map((sentence, index) => (
          // A sentence can repeat (two fields cleared), so the index keeps keys unique.
          <p key={`${index}-${sentence}`} className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1">
            <Lock className="h-3 w-3 flex-shrink-0" />
            {sentence} · {time}
          </p>
        ))}
      </div>
    );
  }
  if (isLinkEvent(message) || isProblemEvent(message) || isServiceRequestEvent(message)) {
    // Internal: links, merges, major incidents and problems stay with the team.
    return (
      <p className="text-xs text-muted-foreground text-center py-2 px-4 flex items-center justify-center gap-1" data-testid="desk-inbox-link-event">
        <Lock className="h-3 w-3 flex-shrink-0" />
        {eventSentence(message, members, visitorLabel)} · {format(new Date(message.createdAt), 'HH:mm')}
      </p>
    );
  }
  const slaEvent = message.metadata?.eventType;
  if (slaEvent === 'sla_warning' || slaEvent === 'sla_breached') {
    // Internal, like a note: only the team sees SLA warnings and breaches.
    return (
      <p
        className={cn(
          'text-xs text-center py-2 px-4 flex items-center justify-center gap-1',
          slaEvent === 'sla_breached' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
        )}
        data-testid="desk-inbox-sla-event"
      >
        <Lock className="h-3 w-3 flex-shrink-0" />
        {eventSentence(message, members, visitorLabel)} · {format(new Date(message.createdAt), 'HH:mm')}
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-muted-foreground text-center py-2 px-4">
        {eventSentence(message, members, visitorLabel)} · {format(new Date(message.createdAt), 'HH:mm')}
      </p>
      {comment && (
        <p
          className="mx-auto -mt-1 mb-2 max-w-md px-4 text-center text-xs italic text-foreground/80 whitespace-pre-wrap break-words"
          data-testid="desk-inbox-rating-comment"
        >
          “{comment}”
        </p>
      )}
    </>
  );
}

type Strings = ReturnType<typeof getTranslations<'deskInbox2'>>;

/** How long ago, short: "Now", "4min", "2h", "3d", then the date. */
function shortAgo(date: Date, now: number, t: Strings): string {
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return t.pane.timeNow;
  if (minutes < 60) return t.pane.timeMinutes.replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.pane.timeHours.replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 7) return t.pane.timeDays.replace('{n}', String(days));
  return format(date, 'd MMM');
}

function Avatar({ label, picture, isBot }: Readonly<{ label: string; picture?: string | null; isBot?: boolean }>) {
  return (
    <UiAvatar className="w-6 h-6 flex-shrink-0" title={label}>
      {picture && <AvatarImage src={picture} alt={label} />}
      <AvatarFallback
        className="text-white font-semibold text-[10px]"
        style={{ backgroundColor: getAvatarColor(label) }}
      >
        {isBot ? <Bot className="h-3 w-3" /> : label.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </UiAvatar>
  );
}

function DaySeparator({ date }: Readonly<{ date: Date }>) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="h-px flex-1 bg-border/70" />
      <span className="text-xs font-medium text-muted-foreground">{format(date, 'PPP')}</span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function TypingBubble({ names }: Readonly<{ names: string[] }>) {
  const t = getTranslations('deskInbox2');
  return (
    <div className="flex items-end gap-2 px-4 pt-1 pb-2" data-testid="desk-inbox-typing">
      <div className="w-6 flex-shrink-0" />
      <div className="flex flex-col items-start gap-1">
        <div className="inline-flex items-center gap-1 rounded-xl bg-muted px-3.5 py-3">
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

export function MessagesTimeline({ conversation, messages, members, typing, onRetry }: Readonly<MessagesTimelineProps>) {
  const t = getTranslations('deskInbox2');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // A clock so "4min" moves on while the conversation is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
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
  const last = messages.at(-1);
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
                <EventRow message={message} members={members} visitorLabel={visitorLabel} />
              </div>
            );
          }

          // Phone events and voicemail: a timeline line or a player, not a bubble from an agent.
          if (isPhoneTimelineMessage(message)) {
            return (
              <div key={message.clientId ?? message.id}>
                {showDay && <DaySeparator date={created} />}
                <PhoneTimelineRow message={message} />
              </div>
            );
          }

          const isVisitor = message.authorType === 'visitor';
          const isNote = message.kind === 'note';
          const isBot = message.authorType === 'bot';
          const member = members.find((m) => m.userId === message.authorId);
          const label = authorLabel(message, members, visitorLabel);

          return (
            <div key={message.clientId ?? message.id}>
              {showDay && <DaySeparator date={created} />}
              {/* One bubble per message, its avatar beside it and the time inside it (Intercom's inbox). */}
              <div className={cn('flex items-end gap-2 px-4 pt-3', isVisitor ? 'flex-row' : 'flex-row-reverse')}>
                <Avatar label={label} picture={isVisitor ? null : member?.picture} isBot={isBot} />
                <div className={cn('flex flex-col max-w-[70%] min-w-0', isVisitor ? 'items-start' : 'items-end')}>
                  <div
                    className={cn(
                      'rounded-xl px-3.5 pt-2.5 pb-2 text-[14px] leading-relaxed',
                      isVisitor && 'bg-muted text-foreground',
                      !isVisitor && !isNote && 'bg-indigo-100 text-gray-900 dark:bg-indigo-500/20 dark:text-foreground',
                      isNote &&
                        'bg-amber-50 text-amber-950 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:border-amber-900',
                      message.pending === 'sending' && 'opacity-70',
                      message.pending === 'failed' && 'opacity-60 ring-1 ring-destructive/60',
                    )}
                  >
                    <span className="sr-only">{label}: </span>
                    {message.body && (
                      <div className="whitespace-pre-wrap break-words">
                        <LinkifiedText text={message.body} />
                      </div>
                    )}
                    <AttachmentList attachments={message.attachments} spaced={Boolean(message.body)} />
                    <div
                      className={cn(
                        'mt-1 flex items-center gap-1 text-[11px] leading-4',
                        isVisitor && 'text-muted-foreground',
                        !isVisitor && !isNote && 'justify-end text-gray-500 dark:text-muted-foreground',
                        isNote && 'justify-end text-amber-700 dark:text-amber-400',
                      )}
                    >
                      {isNote && (
                        <>
                          <Lock className="h-3 w-3" aria-hidden="true" />
                          <span>{t.pane.internalNote}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      {message.pending === 'sending' ? (
                        <span>{t.pane.sending}</span>
                      ) : (
                        <time dateTime={message.createdAt} title={format(created, 'PPpp')}>
                          {shortAgo(created, now, t)}
                        </time>
                      )}
                    </div>
                  </div>
                  <MessageTranslation conversation={conversation} messages={messages} message={message} />
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
