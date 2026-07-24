
import * as React from 'react';
import { useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Mail,
  Phone,
  Calendar,
  StickyNote,
  SquareCheck,
  Presentation,
  SquareActivity,
  Video,
  UserPlus,
  UserMinus,
  Pencil,
  ShieldCheck,
  Handshake,
  ArrowRightLeft,
  Trophy,
  XCircle,
  PencilLine,
  FileUp,
  FileX,
  ListPlus,
  ListMinus,
  RefreshCw,
  ChevronDown,
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
import type { ActivitySectionProps, Activity as ActivityType } from '../types';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import type { Member } from '@weldsuite/core-api-client/schemas/members';
import { useTranslations } from '@weldsuite/i18n/client';

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// ────────────────────────────────────────────────────────────────────
// Tone + icon mapping (mirrors the team-member-panel activity tab)

type Tone = 'emerald' | 'red' | 'slate' | 'blue' | 'green' | 'amber' | 'orange' | 'violet' | 'cyan' | 'yellow';

interface ActivityMeta {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: Tone;
  verb: string;
}

const ACTIVITY_META: Record<string, ActivityMeta> = {
  call: { icon: Phone, tone: 'blue', verb: 'logged a call' },
  email: { icon: Mail, tone: 'violet', verb: 'sent an email' },
  meeting: { icon: Calendar, tone: 'orange', verb: 'scheduled a meeting' },
  task: { icon: SquareCheck, tone: 'amber', verb: 'created a task' },
  note: { icon: StickyNote, tone: 'yellow', verb: 'added a note' },
  demo: { icon: Presentation, tone: 'cyan', verb: 'scheduled a demo' },
  presentation: { icon: Video, tone: 'cyan', verb: 'shared a presentation' },
  customer_created: { icon: UserPlus, tone: 'emerald', verb: 'created this customer' },
  customer_updated: { icon: Pencil, tone: 'slate', verb: 'updated customer details' },
  customer_status_changed: { icon: ShieldCheck, tone: 'amber', verb: 'changed the status' },
  contact_added: { icon: UserPlus, tone: 'green', verb: 'linked a contact' },
  contact_removed: { icon: UserMinus, tone: 'slate', verb: 'unlinked a contact' },
  deal_created: { icon: Handshake, tone: 'blue', verb: 'created a deal' },
  deal_stage_changed: { icon: ArrowRightLeft, tone: 'blue', verb: 'moved a deal' },
  deal_won: { icon: Trophy, tone: 'emerald', verb: 'won a deal' },
  deal_lost: { icon: XCircle, tone: 'red', verb: 'lost a deal' },
  deal_updated: { icon: PencilLine, tone: 'slate', verb: 'updated a deal' },
  file_uploaded: { icon: FileUp, tone: 'cyan', verb: 'uploaded a file' },
  file_deleted: { icon: FileX, tone: 'red', verb: 'deleted a file' },
  list_added: { icon: ListPlus, tone: 'blue', verb: 'added to a list' },
  list_removed: { icon: ListMinus, tone: 'slate', verb: 'removed from a list' },
  lead_converted: { icon: RefreshCw, tone: 'emerald', verb: 'converted a lead' },
};

const TONE_CSS: Record<Tone, { dotFill: string; dotIcon: string }> = {
  emerald: { dotFill: 'bg-emerald-100 dark:bg-emerald-500/15', dotIcon: 'text-emerald-600 dark:text-emerald-400' },
  red: { dotFill: 'bg-red-100 dark:bg-red-500/15', dotIcon: 'text-red-600 dark:text-red-400' },
  slate: { dotFill: 'bg-slate-200 dark:bg-slate-500/20', dotIcon: 'text-slate-600 dark:text-slate-300' },
  blue: { dotFill: 'bg-blue-100 dark:bg-blue-500/15', dotIcon: 'text-blue-600 dark:text-blue-400' },
  green: { dotFill: 'bg-green-100 dark:bg-green-500/15', dotIcon: 'text-green-600 dark:text-green-400' },
  amber: { dotFill: 'bg-amber-100 dark:bg-amber-500/15', dotIcon: 'text-amber-600 dark:text-amber-400' },
  orange: { dotFill: 'bg-orange-100 dark:bg-orange-500/15', dotIcon: 'text-orange-600 dark:text-orange-400' },
  violet: { dotFill: 'bg-violet-100 dark:bg-violet-500/15', dotIcon: 'text-violet-600 dark:text-violet-400' },
  cyan: { dotFill: 'bg-cyan-100 dark:bg-cyan-500/15', dotIcon: 'text-cyan-600 dark:text-cyan-400' },
  yellow: { dotFill: 'bg-yellow-100 dark:bg-yellow-500/15', dotIcon: 'text-yellow-600 dark:text-yellow-400' },
};

function getMeta(type: string): ActivityMeta & { tones: (typeof TONE_CSS)[Tone] } {
  const meta = ACTIVITY_META[type] ?? { icon: SquareActivity, tone: 'slate' as Tone, verb: type.replace(/_/g, ' ') };
  return { ...meta, tones: TONE_CSS[meta.tone] };
}

// ────────────────────────────────────────────────────────────────────
// Change extraction

const FIELD_LABELS: Record<string, string> = {
  email: 'Email', firstName: 'First name', lastName: 'Last name', fullName: 'Full name',
  companyName: 'Company name', tradingName: 'Trading name', phone: 'Phone', mobile: 'Mobile',
  website: 'Website', segment: 'Segment', status: 'Status', source: 'Source',
  industry: 'Industry', vatNumber: 'VAT number', registrationNumber: 'Registration number',
  paymentTerms: 'Payment terms', currency: 'Currency', notes: 'Notes',
  employeeCount: 'Employee count', funding: 'Funding', stage: 'Stage',
  amount: 'Amount', probability: 'Probability', closeDate: 'Close date',
  pipeline: 'Pipeline', type: 'Type', priority: 'Priority',
};

interface ChangeEntry { field: string; from?: string; to?: string; }

function extractChanges(activity: ActivityItem): ChangeEntry[] {
  // The field-change diff moved out of the custom_fields blob into the dedicated
  // `change_log` column (docs/custom-fields-blob-extraction.md). Prefer it, and
  // fall back to the legacy blob until Phase 4 drops that column. Both hold the
  // same shape — whatever subset of changes/__changeLog/previousValues/... the
  // (now-deleted) writer produced.
  const cf = ((activity as { changeLog?: Record<string, unknown> | null }).changeLog ??
    activity.customFields) as Record<string, unknown> | null | undefined;
  if (!cf) return [];
  const changeLog = (cf.changes || cf.__changeLog || cf.changedFields) as Record<string, { from?: string; to?: string }> | undefined;
  if (changeLog && typeof changeLog === 'object') {
    return Object.entries(changeLog).map(([field, val]) => ({
      field: FIELD_LABELS[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
      from: val?.from != null ? String(val.from) : undefined,
      to: val?.to != null ? String(val.to) : undefined,
    }));
  }
  const prev = cf.previousValues as Record<string, unknown> | undefined;
  const next = cf.newValues as Record<string, unknown> | undefined;
  if (prev && next) {
    return Object.keys(next).map(field => ({
      field: FIELD_LABELS[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()),
      from: prev[field] != null ? String(prev[field]) : undefined,
      to: next[field] != null ? String(next[field]) : undefined,
    }));
  }
  return [];
}

// ────────────────────────────────────────────────────────────────────
// Time helpers

function smartTime(date: Date, now: Date = new Date()): string {
  if (isToday(date)) {
    const mins = differenceInMinutes(now, date);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = differenceInHours(now, date);
    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  }
  if (isYesterday(date)) return `Yesterday at ${format(date, 'HH:mm')}`;
  if (isThisWeek(date, { weekStartsOn: 1 })) return `${format(date, 'EEEE')} at ${format(date, 'HH:mm')}`;
  if (isThisYear(date)) return `${format(date, 'MMM d')} at ${format(date, 'HH:mm')}`;
  return `${format(date, 'MMM d, yyyy')} at ${format(date, 'HH:mm')}`;
}

function bucketLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEEE, MMMM d');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ────────────────────────────────────────────────────────────────────

interface ActivityItem extends ActivityType {
  id: string;
}

interface DayBucket {
  key: string;
  label: string;
  date: Date;
  entries: ActivityItem[];
}

export function ActivitySection({ activities }: ActivitySectionProps) {
  const t = useTranslations();
  const { data: membersResult } = useWorkspaceMembers(1, 100);

  const userMap = useMemo(() => {
    const map = new Map<string, string>();
    if (membersResult?.data) {
      for (const m of membersResult.data as Member[]) {
        if (m.userId && m.name) map.set(m.userId, m.name);
      }
    }
    return map;
  }, [membersResult]);

  const items: ActivityItem[] = useMemo(
    () => activities.map((a, i) => ({ ...a, id: a.id || `activity-${i}` })),
    [activities],
  );

  const grouped = useMemo<DayBucket[]>(() => {
    const map = new Map<string, DayBucket>();
    for (const it of items) {
      const d = new Date(it.createdAt);
      const key = format(d, 'yyyy-MM-dd');
      const bucket = map.get(key) ?? { key, label: bucketLabel(d), date: d, entries: [] };
      bucket.entries.push(it);
      map.set(key, bucket);
    }
    return Array.from(map.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center text-center px-6 py-12 gap-2">
        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
          <SquareActivity className="h-5 w-5" />
        </div>
        <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.activitySection.noActivitiesYet')}</h3>
        <p className="text-xs text-muted-foreground max-w-[260px]">{t('sweep.weldcrm.activitySection.noActivitiesYetDescription')}</p>
      </div>
    );
  }

  return (
    <div className="px-4 pt-[18px] pb-4">
      {grouped.map((bucket, idx) => (
        <DaySection key={bucket.key} bucket={bucket} isFirst={idx === 0} userMap={userMap} />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Day section

function DaySection({ bucket, isFirst, userMap }: { bucket: DayBucket; isFirst: boolean; userMap: Map<string, string> }) {
  const showSeparator = bucket.label !== 'Today';

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
        <div className="pointer-events-none absolute left-[8px] top-1 bottom-1 w-px bg-border" aria-hidden />
        {bucket.entries.map((entry, i) => (
          <ActivityRow key={entry.id} activity={entry} userMap={userMap} isFirst={isFirst && i === 0} />
        ))}
      </ol>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Activity row — minimalist timeline, no card border

function ActivityRow({ activity, userMap, isFirst }: { activity: ActivityItem; userMap: Map<string, string>; isFirst?: boolean }) {
  const t = useTranslations();
  const [expanded, setExpanded] = React.useState(false);
  const meta = getMeta(activity.type);
  const Icon = meta.icon;
  const changes = extractChanges(activity);
  const hasChanges = changes.length > 0;
  const createdAt = new Date(activity.createdAt);

  const userName = userMap.get(activity.assignedToId) || t('sweep.weldcrm.contactDetailView.system');
  const subject = stripHtml(activity.subject || '');

  return (
    <li className="group relative">
      <span
        className={cn(
          'absolute left-0 z-10 flex items-center justify-center',
          isFirst ? 'top-0' : 'top-[10px]',
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
            isFirst && 'pt-0',
            hasChanges && 'cursor-pointer',
          )}
        >
          <p className="text-[13px] leading-snug text-foreground flex flex-wrap items-center gap-x-1">
            <span className="font-medium">{userName}</span>
            <span>{meta.verb}</span>
            {subject && !hasChanges && (
              <span className="font-medium text-foreground">&ldquo;{subject}&rdquo;</span>
            )}
          </p>

          <div className="mt-0.5 flex items-center gap-2 text-[12px] font-mono text-muted-foreground">
            <time dateTime={activity.createdAt} title={format(createdAt, 'PPpp')}>
              {smartTime(createdAt)}
            </time>
            {hasChanges && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-0.5 group-hover:text-foreground transition-colors">
                  {changes.length === 1
                    ? t('sweep.weldcrm.activitySection.changeCountSingular', { count: changes.length })
                    : t('sweep.weldcrm.activitySection.changeCountPlural', { count: changes.length })}
                  <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
                </span>
              </>
            )}
          </div>
        </Button>

        {expanded && hasChanges && (
          <div className="pl-11 pr-6 pb-2">
            <div className="rounded-md border border-border/70 bg-background divide-y divide-border/50 text-[11px]">
              {changes.map(({ field, from, to }) => (
                <div key={field} className="grid grid-cols-[100px_1fr] gap-2 px-2.5 py-1.5">
                  <span className="font-medium text-muted-foreground capitalize">{field}</span>
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
