import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  SquareActivity,
  Lock,
  ChevronDown,
  User,
  Building2,
  Briefcase,
  FolderKanban,
  Ticket,
  CheckSquare,
  Mail,
  FileText,
  Package,
  ShoppingCart,
  Tag,
  Calendar,
  Box,
} from 'lucide-react';
import {
  isToday,
  isYesterday,
  isThisWeek,
  isThisYear,
  differenceInMinutes,
  differenceInHours,
  format,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useMemberActivity } from '@/hooks/queries/use-team-queries';
import type { MemberActivityItem } from '@weldsuite/core-api-client/schemas/member-profile';
import { asText } from '@weldsuite/text';

/**
 * Member "Activity" tab — a timeline.
 *
 * Each day is a list of events on a thin vertical rail: a round icon marker,
 * a sentence ("daniel s created 4 × Project") with the time on the right, and
 * underneath it one bordered card per record the event is about. Cards for
 * edits show which fields changed and open to the before → after values.
 */

interface ActivityTabProps {
  userId: string;
  canView: boolean;
  /** The member's display name — the subject of every event sentence. */
  memberName?: string;
}

type Translator = (path: string, params?: Record<string, unknown>) => string;

// ────────────────────────────────────────────────────────────────────
// Record types

type IconComponent = React.ComponentType<{ className?: string }>;

/**
 * Icon per record type, matched on a keyword in the type. Order matters:
 * `project_task` is a task and `project_member` a member, so the generic
 * `project` match comes last.
 */
const ENTITY_ICONS: Array<[keywords: string[], icon: IconComponent]> = [
  [['task', 'checklist'], CheckSquare],
  [['label', 'tag'], Tag],
  [['member', 'user', 'person', 'contact', 'customer'], User],
  [['company', 'account', 'organization'], Building2],
  [['deal', 'opportunity', 'lead'], Briefcase],
  [['ticket', 'conversation'], Ticket],
  [['email', 'message'], Mail],
  [['meeting', 'session', 'event'], Calendar],
  [['page', 'document', 'note'], FileText],
  [['order'], ShoppingCart],
  [['product'], Package],
  [['project'], FolderKanban],
];

function entityIcon(entityType: string): IconComponent {
  const key = entityType.toLowerCase();
  return ENTITY_ICONS.find(([keywords]) => keywords.some((k) => key.includes(k)))?.[1] ?? Box;
}

/** Record types that have a translated name under `sweep.shared.entityType`. */
const TRANSLATED_ENTITY_TYPES = new Set([
  'person', 'customer', 'user', 'member', 'company', 'account', 'organization', 'deal', 'opportunity', 'lead',
  'project', 'ticket', 'conversation', 'task', 'note', 'email', 'message', 'document', 'product', 'order',
  'tag', 'team', 'event',
]);

/** "Task", "Company", "Meeting session", … */
function entityTypeLabel(entityType: string, t: Translator): string {
  const key = entityType.toLowerCase();
  // `personal_task` / `project_task` → `task`
  const candidate = TRANSLATED_ENTITY_TYPES.has(key) ? key : (key.split(/[_-]/).pop() ?? key);
  if (TRANSLATED_ENTITY_TYPES.has(candidate)) return t(`sweep.shared.entityType.${candidate}`);
  const words = entityType.replace(/[_-]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ────────────────────────────────────────────────────────────────────
// What happened

const ACTION_LABEL_KEYS: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  archived: 'archived',
  status_changed: 'statusChanged',
  assigned: 'assigned',
  escalated: 'escalated',
  priority_changed: 'priorityChanged',
  added: 'added',
  removed: 'removed',
};

function sentenceCase(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function actionLabel(action: string, t: Translator): string {
  const key = ACTION_LABEL_KEYS[action];
  return key ? t(`sweep.shared.activityAction.${key}`) : sentenceCase(action);
}

const QUOTED_NAME = /'([^']+)'|"([^"]+)"/;

/** The record name an event quotes (`'rf' was created` → `rf`), if any. */
function quotedName(description: string): string | null {
  const match = QUOTED_NAME.exec(description);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Readable form of a changed value: "frequency: custom, interval: 2" rather than raw JSON. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.map((v) => formatValue(v)).join(', ') : '—';
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${formatValue(v)}`);
    return pairs.length > 0 ? pairs.join(', ') : '—';
  }
  // ISO timestamps (due dates and the like) read as a date, not as raw machine text.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return format(date, 'MMM d, yyyy');
  }
  return asText(value);
}

// ────────────────────────────────────────────────────────────────────
// Grouping + time

interface DayBucket {
  key: string;
  label: string;
  date: Date;
  entries: MemberActivityItem[];
}

/** One card: a record (or several unnamed records of one kind) inside an event. */
interface RecordCard {
  key: string;
  /** The record's name, or its type when the events never name it. */
  title: string;
  /** How many different records are folded into this card (unnamed ones only). */
  recordCount: number;
  entries: MemberActivityItem[];
}

/**
 * One timeline event: everything of one kind the member did to one type of
 * record on one day — "created 4 × Project", "updated Task".
 */
interface TimelineEvent {
  key: string;
  action: string;
  entityType: string;
  cards: RecordCard[];
  /** Newest entry in the event; drives the time on the right. */
  latest: MemberActivityItem;
  /** Different records touched — the count in the sentence. */
  recordCount: number;
}

function bucketLabel(date: Date, t: Translator): string {
  if (isToday(date)) return t('sweep.shared.today');
  if (isYesterday(date)) return t('sweep.shared.yesterday');
  return format(date, 'EEEE, MMMM d');
}

function smartTime(date: Date, t: Translator, now: Date = new Date()): string {
  if (isToday(date)) {
    const mins = differenceInMinutes(now, date);
    if (mins < 1) return t('sweep.shared.justNow');
    if (mins < 60) return t('sweep.shared.minutesAgoShort', { count: mins });
    const hrs = differenceInHours(now, date);
    return t('sweep.shared.hoursAgoShort', { count: hrs });
  }
  if (isYesterday(date)) return t('sweep.shared.yesterdayAtTime', { time: format(date, 'HH:mm') });
  if (isThisWeek(date, { weekStartsOn: 1 })) return t('sweep.shared.weekdayAtTime', { weekday: format(date, 'EEEE'), time: format(date, 'HH:mm') });
  if (isThisYear(date)) return t('sweep.shared.dateAtTime', { date: format(date, 'MMM d'), time: format(date, 'HH:mm') });
  return t('sweep.shared.fullDateAtTime', { date: format(date, 'MMM d, yyyy'), time: format(date, 'HH:mm') });
}

/** Edits with field details all read as "updated", whatever their raw action. */
function eventAction(entry: MemberActivityItem): string {
  if (entry.action !== 'created' && entry.changes && Object.keys(entry.changes).length > 0) return 'updated';
  return entry.action;
}

/**
 * Builds a day's timeline. `names` maps a record id to its name, collected
 * from every loaded entry that quotes one — so an entry that only says
 * "changed Repeat" still lands on the card of the task it belongs to.
 * Records that are never named share one card per event ("Member ×5").
 */
function buildTimeline(entries: MemberActivityItem[], names: Map<string, string>, t: Translator): TimelineEvent[] {
  const events = new Map<string, TimelineEvent & { cardMap: Map<string, RecordCard & { ids: Set<string> }>; ids: Set<string> }>();
  for (const entry of entries) {
    const action = eventAction(entry);
    const eventKey = `${action}:${entry.entityType}`;
    let event = events.get(eventKey);
    if (!event) {
      event = {
        key: eventKey,
        action,
        entityType: entry.entityType,
        cards: [],
        latest: entry,
        recordCount: 0,
        cardMap: new Map(),
        ids: new Set(),
      };
      events.set(eventKey, event);
    }
    const name = names.get(entry.entityId) ?? null;
    const cardKey = name ? entry.entityId : 'unnamed';
    let card = event.cardMap.get(cardKey);
    if (!card) {
      card = {
        key: cardKey,
        title: name ?? entityTypeLabel(entry.entityType, t),
        recordCount: 0,
        entries: [],
        ids: new Set(),
      };
      event.cardMap.set(cardKey, card);
      event.cards.push(card);
    }
    card.entries.push(entry);
    card.ids.add(entry.entityId);
    card.recordCount = card.ids.size;
    event.ids.add(entry.entityId);
    event.recordCount = event.ids.size;
  }
  // Entries arrive newest first, so insertion order is already newest event first.
  return Array.from(events.values());
}

// ────────────────────────────────────────────────────────────────────

export function ActivityTab({ userId, canView, memberName }: Readonly<ActivityTabProps>) {
  const t = useTranslations();
  const query = useMemberActivity(userId, { limit: 50 }, { enabled: canView });
  const items = React.useMemo(
    () => (query.data?.data ?? []) as MemberActivityItem[],
    [query.data],
  );

  const recordNames = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const item of items) {
      const name = quotedName(item.description);
      if (name && !names.has(item.entityId)) names.set(item.entityId, name);
    }
    return names;
  }, [items]);

  const days = React.useMemo<DayBucket[]>(() => {
    const map = new Map<string, DayBucket>();
    for (const it of items) {
      const d = new Date(it.createdAt);
      const key = format(d, 'yyyy-MM-dd');
      const bucket = map.get(key) ?? { key, label: bucketLabel(d, t), date: d, entries: [] };
      bucket.entries.push(it);
      map.set(key, bucket);
    }
    return Array.from(map.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [items, t]);

  if (!canView) {
    return (
      <EmptyState
        icon={<Lock className="h-5 w-5" />}
        title={t('sweep.shared.activityIsPrivateTitle')}
        description={t('sweep.shared.activityIsPrivateDescription')}
      />
    );
  }

  if (query.isLoading) return <ActivitySkeleton />;

  if (query.isError) {
    return (
      <EmptyState
        icon={<SquareActivity className="h-5 w-5 text-destructive" />}
        title={t('sweep.shared.couldntLoadActivityTitle')}
        description={t('sweep.shared.couldntLoadActivityDescription')}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<SquareActivity className="h-5 w-5" />}
        title={t('sweep.shared.noActivityYetTitle')}
        description={t('sweep.shared.noActivityYetDescription')}
      />
    );
  }

  return (
    <div className="p-4 space-y-6">
      {days.map((day) => (
        <section key={day.key}>
          <h4 className="mb-3 text-[13px] leading-5 text-muted-foreground">{day.label}</h4>
          <ol>
            {buildTimeline(day.entries, recordNames, t).map((event, index, all) => (
              <TimelineRow
                key={event.key}
                event={event}
                memberName={memberName}
                isLast={index === all.length - 1}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Timeline event: round marker on the rail, sentence + time, record cards

function TimelineRow({
  event,
  memberName,
  isLast,
}: Readonly<{ event: TimelineEvent; memberName?: string; isLast: boolean }>) {
  const t = useTranslations();
  const Icon = entityIcon(event.entityType);
  const latest = new Date(event.latest.createdAt);
  const typeLabel = entityTypeLabel(event.entityType, t);
  // A card for records that are never named would only repeat the sentence
  // ("added 5 × Member" + a "Member ×5" card), so those events stay a single
  // line — unless the card has changed fields to show.
  const cards = event.cards.filter((card) => card.key !== 'unnamed' || changedFields(card.entries) !== '');
  const entryCount = event.cards.reduce((n, card) => n + card.entries.length, 0);
  const repeats = cards.length === 0 && entryCount > event.recordCount ? entryCount : 0;

  return (
    <li className={cn('relative pl-9', !isLast && 'pb-5')}>
      {/* Rail: runs from under the marker to the next event's marker. */}
      {!isLast && (
        <span className="absolute bottom-0 left-[11.5px] top-7 w-px bg-border" aria-hidden />
      )}
      <span
        className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full border border-border bg-muted/50"
        aria-hidden
      >
        <Icon className="size-3 text-muted-foreground" />
      </span>

      <div className="flex min-h-6 items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          {memberName && <span className="text-foreground">{memberName} </span>}
          {actionLabel(event.action, t).toLowerCase()}{' '}
          <span className="font-medium text-foreground">
            {event.recordCount > 1 ? `${event.recordCount} × ${typeLabel}` : typeLabel}
          </span>
          {repeats > 0 && (
            <>
              {' '}
              <CountChip>×{repeats}</CountChip>
            </>
          )}
        </p>
        <time
          dateTime={event.latest.createdAt}
          title={format(latest, 'PPpp')}
          className="shrink-0 text-xs leading-6 tabular-nums text-muted-foreground"
        >
          {/* The day heading already says which day; older days just show the clock time. */}
          {isToday(latest) ? smartTime(latest, t) : format(latest, 'HH:mm')}
        </time>
      </div>

      {cards.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {cards.map((card) => (
            <RecordCardRow key={card.key} card={card} entityType={event.entityType} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Which fields an edit touched: "Repeat ×6 · Labels". Empty for events without field details. */
function changedFields(entries: MemberActivityItem[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const field of Object.keys(entry.changes ?? {})) {
      const label = sentenceCase(field);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ');
}

function RecordCardRow({ card, entityType }: Readonly<{ card: RecordCard; entityType: string }>) {
  const [open, setOpen] = React.useState(false);
  const Icon = entityIcon(entityType);
  const fields = changedFields(card.entries);
  const withChanges = card.entries.filter((e) => e.changes && Object.keys(e.changes).length > 0);
  const expandable = withChanges.length > 0;
  // Several plain events on one record ("Updated" five times) show as a count.
  const repeats = fields ? 0 : card.entries.length / Math.max(card.recordCount, 1);

  const row = (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{card.title}</span>
      {card.recordCount > 1 && <CountChip>×{card.recordCount}</CountChip>}
      {repeats > 1 && card.recordCount <= 1 && <CountChip>×{repeats}</CountChip>}
      {fields && <span className="max-w-[55%] shrink-0 truncate text-xs text-muted-foreground">{fields}</span>}
      {expandable && (
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/card:text-foreground',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <div className="rounded-lg border border-border/70 bg-muted/30">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="group/card flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row}
        </button>
      ) : (
        <div className="flex h-9 items-center gap-2.5 px-3">{row}</div>
      )}

      {open && expandable && (
        <ol className="space-y-2 border-t border-border/70 px-3 py-2.5">
          {withChanges.flatMap((entry) =>
            Object.entries(entry.changes ?? {}).map(([key, { from, to }]) => (
              <li key={`${entry.id}:${key}`} className="text-xs leading-5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-foreground">{sentenceCase(key)}</span>
                  <time dateTime={entry.createdAt} className="shrink-0 tabular-nums text-muted-foreground">
                    {format(new Date(entry.createdAt), 'HH:mm')}
                  </time>
                </div>
                <div className="text-muted-foreground [overflow-wrap:anywhere]">
                  <span className="line-through decoration-muted-foreground/50">{formatValue(from)}</span>
                  <span aria-hidden> → </span>
                  <span className="text-foreground/80">{formatValue(to)}</span>
                </div>
              </li>
            )),
          )}
        </ol>
      )}
    </div>
  );
}

function CountChip({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-[5px] border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────
// Skeleton + empty state

function ActivitySkeleton() {
  return (
    <div className="p-4 space-y-6">
      {[0, 1].map((i) => (
        <div key={i}>
          <Skeleton className="mb-3 h-3 w-20" />
          {[0, 1].map((j) => (
            <div key={j} className="relative pb-5 pl-9">
              <Skeleton className="absolute left-0 top-0 size-6 rounded-full" />
              <div className="flex h-6 items-center justify-between">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className="mt-1.5 h-9 w-full rounded-lg" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  description: string;
}>) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-12 gap-2">
      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-[260px]">{description}</p>
    </div>
  );
}
