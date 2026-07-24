import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  SquareActivity,
  Lock,
  Plus,
  Trash2,
  Archive,
  ArrowRightLeft,
  UserPlus,
  AlertTriangle,
  Flag,
  Settings,
  Pencil,
  ChevronDown,
  User,
  Building2,
  Briefcase,
  FolderKanban,
  Ticket,
  CheckSquare,
  StickyNote,
  Mail,
  FileText,
  Package,
  ShoppingCart,
  Tag,
  Users,
  Calendar,
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
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useMemberActivity } from '@/hooks/queries/use-team-queries';
import type { MemberActivityItem } from '@weldsuite/core-api-client/schemas/member-profile';

interface ActivityTabProps {
  userId: string;
  canView: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Action styling

type Tone =
  | 'emerald'
  | 'red'
  | 'slate'
  | 'blue'
  | 'green'
  | 'amber'
  | 'orange';

const ACTION_META: Record<
  string,
  { icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; tone: Tone; verb: string }
> = {
  created: { icon: Plus, tone: 'emerald', verb: 'created' },
  deleted: { icon: Trash2, tone: 'red', verb: 'deleted' },
  archived: { icon: Archive, tone: 'slate', verb: 'archived' },
  status_changed: { icon: ArrowRightLeft, tone: 'blue', verb: 'changed status of' },
  assigned: { icon: UserPlus, tone: 'green', verb: 'assigned' },
  escalated: { icon: AlertTriangle, tone: 'amber', verb: 'escalated' },
  priority_changed: { icon: Flag, tone: 'orange', verb: 'changed priority of' },
  updated: { icon: Pencil, tone: 'slate', verb: 'updated' },
};

const TONE_CSS: Record<Tone, { dotFill: string; dotIcon: string; dotRing: string; verb: string; icon: string }> = {
  emerald: {
    dotFill: 'bg-emerald-100 dark:bg-emerald-500/15',
    dotIcon: 'text-emerald-600 dark:text-emerald-400',
    dotRing: 'ring-emerald-500/25',
    verb: 'text-emerald-700 dark:text-emerald-400',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  red: {
    dotFill: 'bg-red-100 dark:bg-red-500/15',
    dotIcon: 'text-red-600 dark:text-red-400',
    dotRing: 'ring-red-500/25',
    verb: 'text-red-700 dark:text-red-400',
    icon: 'text-red-600 dark:text-red-400',
  },
  slate: {
    dotFill: 'bg-slate-200 dark:bg-slate-500/20',
    dotIcon: 'text-slate-600 dark:text-slate-300',
    dotRing: 'ring-slate-500/20',
    verb: 'text-slate-700 dark:text-slate-300',
    icon: 'text-slate-600 dark:text-slate-400',
  },
  blue: {
    dotFill: 'bg-blue-100 dark:bg-blue-500/15',
    dotIcon: 'text-blue-600 dark:text-blue-400',
    dotRing: 'ring-blue-500/25',
    verb: 'text-blue-700 dark:text-blue-400',
    icon: 'text-blue-600 dark:text-blue-400',
  },
  green: {
    dotFill: 'bg-green-100 dark:bg-green-500/15',
    dotIcon: 'text-green-600 dark:text-green-400',
    dotRing: 'ring-green-500/25',
    verb: 'text-green-700 dark:text-green-400',
    icon: 'text-green-600 dark:text-green-400',
  },
  amber: {
    dotFill: 'bg-amber-100 dark:bg-amber-500/15',
    dotIcon: 'text-amber-600 dark:text-amber-400',
    dotRing: 'ring-amber-500/25',
    verb: 'text-amber-700 dark:text-amber-400',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  orange: {
    dotFill: 'bg-orange-100 dark:bg-orange-500/15',
    dotIcon: 'text-orange-600 dark:text-orange-400',
    dotRing: 'ring-orange-500/25',
    verb: 'text-orange-700 dark:text-orange-400',
    icon: 'text-orange-600 dark:text-orange-400',
  },
};

function getMeta(action: string) {
  const meta = ACTION_META[action] ?? { icon: Settings, tone: 'slate' as Tone, verb: action.replace(/_/g, ' ') };
  return { ...meta, tones: TONE_CSS[meta.tone] };
}

function humanEntity(entityType?: string) {
  if (!entityType) return '';
  return entityType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ────────────────────────────────────────────────────────────────────
// Entity chip

const ENTITY_STYLE: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; tone: string; labelKey: string }
> = {
  contact: { icon: User, tone: 'violet', labelKey: 'sweep.shared.entityType.person' },
  person: { icon: User, tone: 'violet', labelKey: 'sweep.shared.entityType.person' },
  customer: { icon: User, tone: 'violet', labelKey: 'sweep.shared.entityType.customer' },
  user: { icon: User, tone: 'violet', labelKey: 'sweep.shared.entityType.user' },
  member: { icon: User, tone: 'violet', labelKey: 'sweep.shared.entityType.member' },
  company: { icon: Building2, tone: 'sky', labelKey: 'sweep.shared.entityType.company' },
  account: { icon: Building2, tone: 'sky', labelKey: 'sweep.shared.entityType.account' },
  organization: { icon: Building2, tone: 'sky', labelKey: 'sweep.shared.entityType.organization' },
  deal: { icon: Briefcase, tone: 'emerald', labelKey: 'sweep.shared.entityType.deal' },
  opportunity: { icon: Briefcase, tone: 'emerald', labelKey: 'sweep.shared.entityType.opportunity' },
  lead: { icon: Briefcase, tone: 'emerald', labelKey: 'sweep.shared.entityType.lead' },
  project: { icon: FolderKanban, tone: 'indigo', labelKey: 'sweep.shared.entityType.project' },
  ticket: { icon: Ticket, tone: 'rose', labelKey: 'sweep.shared.entityType.ticket' },
  conversation: { icon: Ticket, tone: 'rose', labelKey: 'sweep.shared.entityType.conversation' },
  task: { icon: CheckSquare, tone: 'amber', labelKey: 'sweep.shared.entityType.task' },
  note: { icon: StickyNote, tone: 'yellow', labelKey: 'sweep.shared.entityType.note' },
  email: { icon: Mail, tone: 'cyan', labelKey: 'sweep.shared.entityType.email' },
  message: { icon: Mail, tone: 'cyan', labelKey: 'sweep.shared.entityType.message' },
  document: { icon: FileText, tone: 'slate', labelKey: 'sweep.shared.entityType.document' },
  product: { icon: Package, tone: 'orange', labelKey: 'sweep.shared.entityType.product' },
  order: { icon: ShoppingCart, tone: 'orange', labelKey: 'sweep.shared.entityType.order' },
  tag: { icon: Tag, tone: 'pink', labelKey: 'sweep.shared.entityType.tag' },
  team: { icon: Users, tone: 'teal', labelKey: 'sweep.shared.entityType.team' },
  event: { icon: Calendar, tone: 'fuchsia', labelKey: 'sweep.shared.entityType.event' },
};

const ENTITY_TONE: Record<string, string> = {
  violet: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-1 ring-violet-500/15',
  sky: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/15',
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/15',
  indigo: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-500/15',
  rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/15',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/15',
  yellow: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 ring-1 ring-yellow-500/15',
  cyan: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 ring-1 ring-cyan-500/15',
  slate: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 ring-1 ring-slate-500/15',
  orange: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 ring-1 ring-orange-500/15',
  pink: 'bg-pink-500/10 text-pink-700 dark:text-pink-300 ring-1 ring-pink-500/15',
  teal: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-1 ring-teal-500/15',
  fuchsia: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300 ring-1 ring-fuchsia-500/15',
};

function getEntityStyle(entityType?: string) {
  if (!entityType) return { icon: Tag, tone: 'slate', labelKey: null as string | null, fallbackLabel: '', classes: ENTITY_TONE.slate };
  const key = entityType.toLowerCase();
  const style = ENTITY_STYLE[key];
  if (style) return { ...style, fallbackLabel: '', classes: ENTITY_TONE[style.tone] ?? ENTITY_TONE.slate };
  return { icon: Tag, tone: 'slate', labelKey: null as string | null, fallbackLabel: humanEntity(entityType), classes: ENTITY_TONE.slate };
}

function EntityChip({ name, entityType }: { name: string; entityType?: string }) {
  const t = useTranslations();
  const style = getEntityStyle(entityType);
  const styleLabel = style.labelKey ? t(style.labelKey) : style.fallbackLabel;

  return (
    <Badge
      variant="secondary"
      className="rounded-[5px] px-1"
      title={styleLabel ? `${styleLabel}: ${name}` : name}
    >
      <span className="truncate max-w-[180px]">{name}</span>
    </Badge>
  );
}

// Entity nouns to emphasize in the description (not action verbs like "created").
const NOUN_WORDS = [
  'conversation',
  'conversations',
  'message',
  'messages',
  'ticket',
  'tickets',
  'contact',
  'contacts',
  'customer',
  'customers',
  'company',
  'companies',
  'deal',
  'deals',
  'lead',
  'leads',
  'opportunity',
  'opportunities',
  'task',
  'tasks',
  'project',
  'projects',
  'note',
  'notes',
  'email',
  'emails',
  'document',
  'documents',
  'order',
  'orders',
  'product',
  'products',
  'event',
  'events',
  'invoice',
  'invoices',
  'member',
  'members',
];
const NOUN_REGEX_SRC = `\\b(${NOUN_WORDS.join('|')})\\b`;

/**
 * Renders the description, turning quoted names into EntityChips and
 * emphasizing entity nouns (conversation, message, …) with semibold foreground text.
 * Action verbs (created, updated, …) are left as plain text.
 */
function renderDescription(description: string, entityType?: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /'([^']+)'|"([^"]+)"/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  let firstReplaced = false;

  const pushText = (text: string) => {
    if (!text) return;
    const nounRegex = new RegExp(NOUN_REGEX_SRC, 'gi');
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = nounRegex.exec(text)) !== null) {
      if (m.index > lastEnd) {
        parts.push(<React.Fragment key={`t${key++}`}>{text.slice(lastEnd, m.index)}</React.Fragment>);
      }
      parts.push(
        <span key={`n${key++}`} className="font-medium text-foreground">
          {m[0]}
        </span>,
      );
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) {
      parts.push(<React.Fragment key={`t${key++}`}>{text.slice(lastEnd)}</React.Fragment>);
    }
  };

  while ((match = regex.exec(description)) !== null) {
    if (match.index > lastIndex) {
      pushText(description.slice(lastIndex, match.index));
    }
    const name = match[1] ?? match[2] ?? '';
    if (!firstReplaced) {
      // The subject of the activity (first quoted name) → styled entity chip
      parts.push(<EntityChip key={`c${key++}`} name={name} entityType={entityType} />);
      firstReplaced = true;
    } else {
      // Subsequent quoted names (people, companies, etc.) stay as plain text
      pushText(name);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < description.length) {
    pushText(description.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [description];
}

// ────────────────────────────────────────────────────────────────────
// Grouping + time

interface DayBucket {
  key: string;
  label: string;
  isToday: boolean;
  date: Date;
  entries: MemberActivityItem[];
}

type Translator = (path: string, params?: Record<string, unknown>) => string;

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

// ────────────────────────────────────────────────────────────────────

export function ActivityTab({ userId, canView }: ActivityTabProps) {
  const t = useTranslations();
  const query = useMemberActivity(userId, { limit: 50 }, { enabled: canView });
  const items = React.useMemo(
    () => (query.data?.data ?? []) as MemberActivityItem[],
    [query.data],
  );

  const grouped = React.useMemo<DayBucket[]>(() => {
    const map = new Map<string, DayBucket>();
    for (const it of items) {
      const d = new Date(it.createdAt);
      const key = format(d, 'yyyy-MM-dd');
      const bucket = map.get(key) ?? { key, label: bucketLabel(d, t), isToday: isToday(d), date: d, entries: [] };
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
    <div className="px-4 py-4">
      {grouped.map((bucket, idx) => (
        <DaySection key={bucket.key} bucket={bucket} isFirst={idx === 0} />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Day section

function DaySection({ bucket, isFirst }: { bucket: DayBucket; isFirst: boolean }) {
  const showSeparator = !bucket.isToday;

  return (
    <section className="relative">
      {showSeparator && (
        <div className={cn('flex items-center gap-3', isFirst ? 'pt-2 pb-2' : 'pt-8 pb-2')}>
          <span className="text-[11px] font-medium text-gray-400 dark:text-muted-foreground uppercase tracking-wider whitespace-nowrap">
            {bucket.label}
          </span>
          <div className="flex-1 h-px bg-gray-100 dark:bg-border" />
        </div>
      )}

      <ol className="relative">
        {/* Timeline rail */}
        <div
          className="pointer-events-none absolute left-[8px] top-1 bottom-1 w-px bg-border"
          aria-hidden
        />
        {bucket.entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Activity row — minimalist timeline, no card border

function ActivityRow({ entry }: { entry: MemberActivityItem }) {
  const t = useTranslations();
  const [expanded, setExpanded] = React.useState(false);
  const meta = getMeta(entry.action);
  const Icon = meta.icon;
  const changes = entry.changes ? Object.entries(entry.changes) : [];
  const hasChanges = changes.length > 0;
  const createdAt = new Date(entry.createdAt);

  return (
    <li className="group relative">
      {/* Square marker with icon inside, pinned on the rail */}
      <span
        className={cn(
          'absolute left-0 top-[10px] z-10 flex items-center justify-center',
          'h-[18px] w-[18px] rounded-[6px] ring-[3px] ring-background',
          meta.tones.dotFill,
        )}
        aria-hidden
      >
        <Icon className={cn('h-[10px] w-[10px]', meta.tones.dotIcon)} strokeWidth={2.75} />
      </span>

      <div
        className={cn(
          'w-[calc(100%+32px)] -ml-4 transition-colors',
          hasChanges && 'group-hover:bg-muted/60',
        )}
      >
      <Button
        type="button"
        variant="ghost"
        disabled={!hasChanges}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'text-left w-full pl-11 pr-6 py-2.5 cursor-default',
          hasChanges && 'cursor-pointer',
        )}
      >
        <p className="text-[13px] leading-snug text-foreground flex flex-wrap items-center gap-x-1 gap-y-1">
          {renderDescription(entry.description, entry.entityType)}
        </p>

        <div className="mt-0.5 flex items-center gap-2 text-[12px] font-mono text-muted-foreground">
          <time dateTime={entry.createdAt} title={format(createdAt, 'PPpp')}>
            {smartTime(createdAt, t)}
          </time>
          {hasChanges && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-0.5 group-hover:text-foreground transition-colors">
                {t(changes.length === 1 ? 'sweep.shared.changeCountOne' : 'sweep.shared.changeCountOther', { count: changes.length })}
                <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
              </span>
            </>
          )}
        </div>
      </Button>

      {expanded && hasChanges && (
        <div className="pl-11 pr-6 pb-2">
          <div className="rounded-md border border-border/70 bg-background divide-y divide-border/50 text-[11px]">
            {changes.map(([key, { from, to }]) => (
              <div key={key} className="grid grid-cols-[100px_1fr] gap-2 px-2.5 py-1.5">
                <span className="font-medium text-muted-foreground capitalize">
                  {key.replace(/_/g, ' ')}
                </span>
                <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                  <code className="line-through decoration-red-400/60 text-muted-foreground truncate max-w-[180px]">
                    {formatValue(from)}
                  </code>
                  <ArrowRightLeft className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <code className="text-foreground font-medium truncate max-w-[180px]">
                    {formatValue(to)}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </li>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ────────────────────────────────────────────────────────────────────
// Skeleton + empty state

function ActivitySkeleton() {
  return (
    <div className="px-4 py-4 space-y-6">
      {[0, 1].map((i) => (
        <div key={i}>
          <Skeleton className="h-5 w-28 rounded-full mb-3" />
          <div className="relative">
            <div className="pointer-events-none absolute left-[8px] top-1 bottom-1 w-px bg-border" aria-hidden />
            {[0, 1, 2].map((j) => (
              <div key={j} className="relative py-1.5 pl-7">
                <Skeleton className="absolute left-0 top-2 h-[18px] w-[18px] rounded-[6px]" />
                <Skeleton className="h-3 w-3/4 mb-1.5" />
                <Skeleton className="h-2.5 w-1/4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
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
