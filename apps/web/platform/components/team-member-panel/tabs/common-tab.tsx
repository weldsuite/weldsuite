import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  Hash,
  Lock,
  MessageSquare,
  FolderKanban,
  CheckSquare,
  Briefcase,
  LifeBuoy,
  Users,
  ChevronRight,
  UserCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { useCommonConcepts } from '@/hooks/queries/use-team-queries';
import type { CommonConceptsResponse } from '@weldsuite/core-api-client/schemas/member-profile';

interface CommonTabProps {
  userId: string;
  isSelf: boolean;
}

type Tone = 'blue' | 'indigo' | 'amber' | 'emerald' | 'rose';

const TONE_CSS: Record<Tone, { iconBg: string; iconText: string }> = {
  blue: { iconBg: 'bg-blue-100 dark:bg-blue-500/15', iconText: 'text-blue-600 dark:text-blue-400' },
  indigo: {
    iconBg: 'bg-indigo-100 dark:bg-indigo-500/15',
    iconText: 'text-indigo-600 dark:text-indigo-400',
  },
  amber: { iconBg: 'bg-amber-100 dark:bg-amber-500/15', iconText: 'text-amber-600 dark:text-amber-400' },
  emerald: {
    iconBg: 'bg-emerald-100 dark:bg-emerald-500/15',
    iconText: 'text-emerald-600 dark:text-emerald-400',
  },
  rose: { iconBg: 'bg-rose-100 dark:bg-rose-500/15', iconText: 'text-rose-600 dark:text-rose-400' },
};

export function CommonTab({ userId, isSelf }: CommonTabProps) {
  const t = useTranslations();
  const query = useCommonConcepts(userId);
  const { open: openEntitySheet } = useEntitySheet();

  if (isSelf) {
    return (
      <EmptyState
        icon={<UserCircle2 className="h-5 w-5" />}
        title={t('sweep.shared.thatsYouTitle')}
        description={t('sweep.shared.thatsYouDescription')}
      />
    );
  }

  if (query.isLoading) return <CommonSkeleton />;

  if (!query.data) {
    return (
      <EmptyState
        icon={<Users className="h-5 w-5 text-destructive" />}
        title={t('sweep.shared.couldntLoadSharedItemsTitle')}
        description={t('sweep.shared.couldntLoadSharedItemsDescription')}
      />
    );
  }

  const data = query.data as CommonConceptsResponse;
  // Opportunities no longer have a dedicated detail page either — they open
  // in the entity sheet. Activities never had one. Only opportunities are
  // surfaced here, via the sheet.
  const crmRecords = data.crm.filter((r) => r.kind === 'opportunity');
  const total =
    data.channels.length + data.projects.length + data.tasks.length + crmRecords.length + data.helpdesk.length;

  if (total === 0) {
    return (
      <EmptyState
        icon={<Users className="h-5 w-5" />}
        title={t('sweep.shared.nothingInCommonYetTitle')}
        description={t('sweep.shared.nothingInCommonYetDescription')}
      />
    );
  }

  return (
    <div className="p-4 space-y-6">
      <Section title={t('sweep.shared.channelsAndDms')} tone="blue" count={data.channels.length}>
        {data.channels.map((c) => (
          <Row
            key={c.id}
            tone="blue"
            to={`/weldchat/c/${c.id}`}
            label={c.type === 'dm' ? c.name : `# ${c.name}`}
            hint={t(c.memberCount === 1 ? 'sweep.shared.memberCountOne' : 'sweep.shared.memberCountOther', { count: c.memberCount })}
            leading={
              c.type === 'dm'
                ? c.memberCount > 2
                  ? <GroupDmAvatar name={c.name} />
                  : <DmAvatar name={c.name} />
                : <ChannelAvatar type={c.type} />
            }
          />
        ))}
      </Section>

      <Section title={t('sweep.shared.projects')} tone="indigo" count={data.projects.length}>
        {data.projects.map((p) => (
          <Row
            key={p.id}
            tone="indigo"
            to={`/projects/${p.id}`}
            label={p.name}
            hint={p.status ?? undefined}
            leading={<ProjectAvatar color={p.color} />}
          />
        ))}
      </Section>

      <Section title={t('sweep.shared.tasks')} tone="amber" count={data.tasks.length}>
        {data.tasks.map((task) => (
          <Row
            key={task.id}
            tone="amber"
            to={task.projectId ? `/projects/${task.projectId}/tasks/${task.id}` : `/task/${task.id}`}
            label={task.title}
            hint={`${task.status}${task.role === 'delegated' ? ` · ${t('sweep.shared.delegated')}` : ''}`}
            leading={<CategoryIcon tone="amber" icon={<CheckSquare className="h-3 w-3" />} />}
          />
        ))}
      </Section>

      <Section title={t('sweep.shared.crm')} tone="emerald" count={crmRecords.length}>
        {crmRecords.map((r) => (
          <Row
            key={r.id}
            tone="emerald"
            onSelect={() => openEntitySheet('opportunity', r.id)}
            label={r.name}
            hint={r.status ?? r.kind}
            leading={<CategoryIcon tone="emerald" icon={<Briefcase className="h-3 w-3" />} />}
          />
        ))}
      </Section>

      <Section title={t('sweep.shared.helpdesk')} tone="rose" count={data.helpdesk.length}>
        {data.helpdesk.map((h) => (
          <Row
            key={h.id}
            tone="rose"
            to={`/welddesk/conversations/${h.id}`}
            label={h.subject}
            hint={h.status}
            leading={<CategoryIcon tone="rose" icon={<LifeBuoy className="h-3 w-3" />} />}
          />
        ))}
      </Section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Section

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: Tone;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h4>
        <span className="inline-flex items-center justify-center size-[17px] text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-[5px]">
          {count}
        </span>
        <div className="flex-1 h-px bg-gray-100 dark:bg-border" />
      </div>
      <ul className="-mx-4">{children}</ul>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// Row

function Row({
  to,
  onSelect,
  label,
  hint,
  leading,
}: {
  /** Navigate to a route. Mutually exclusive with `onSelect`. */
  to?: string;
  /** Handle the click in-app (e.g. open an entity sheet). Takes precedence over `to`. */
  onSelect?: () => void;
  label: string;
  hint?: string;
  tone?: Tone;
  /** Optional leading visual (avatar, icon). */
  leading?: React.ReactNode;
}) {
  const className = cn(
    'group flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/60',
  );
  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-foreground truncate">{label}</p>
        {hint && (
          <p className="text-[11px] text-muted-foreground truncate capitalize">{hint}</p>
        )}
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </>
  );
  return (
    <li>
      {onSelect ? (
        <Button type="button" variant="ghost" onClick={onSelect} className={className}>
          {inner}
        </Button>
      ) : (
        <Link to={(to ?? '/') as any} className={className}>
          {inner}
        </Link>
      )}
    </li>
  );
}

function ChannelAvatar({ type }: { type: 'public' | 'private' | 'dm' }) {
  if (type === 'public') {
    return (
      <span className="h-5 w-5 rounded-[6px] bg-muted flex items-center justify-center text-muted-foreground">
        <Hash className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="h-5 w-5 rounded-[6px] bg-muted flex items-center justify-center text-muted-foreground">
      <Lock className="h-3 w-3" />
    </span>
  );
}

function CategoryIcon({ tone, icon }: { tone: Tone; icon: React.ReactNode }) {
  const t = TONE_CSS[tone];
  return (
    <span
      className={cn(
        'h-5 w-5 rounded-[6px] flex items-center justify-center',
        t.iconBg,
      )}
    >
      <span className={t.iconText}>{icon}</span>
    </span>
  );
}

function ProjectAvatar({ color }: { color?: string | null }) {
  return (
    <span
      className={cn(
        'flex items-center justify-center w-[18px] h-[18px] rounded-[6px]',
        color || 'bg-gray-500',
      )}
    >
      <FolderKanban className="h-2.5 w-2.5 text-white" />
    </span>
  );
}

function DmAvatar({ name, picture }: { name: string; picture?: string }) {
  return (
    <Avatar className="h-5 w-5 !rounded-[6px]">
      {picture && <AvatarImage src={picture} className="!rounded-[6px]" />}
      <AvatarFallback className="text-[9px] !rounded-[6px]">
        {(name || '?')[0]!.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function GroupDmAvatar({ name }: { name: string }) {
  const parts = name.split(/[,&]+/).map((s) => s.trim()).filter(Boolean);
  const visible = parts.slice(0, 2);
  if (visible.length === 0) visible.push('?', '?');
  else if (visible.length === 1) visible.push(visible[0]!);
  return (
    <div className="relative h-5 w-5 flex-shrink-0">
      {visible.map((label, i) => (
        <Avatar
          key={i}
          className={cn(
            'h-[13px] w-[13px] absolute !rounded-[4px] border border-background',
            i === 0 ? 'top-0 left-0 z-10' : 'bottom-0 right-0',
          )}
        >
          <AvatarFallback className="text-[7px] !rounded-[4px]">
            {(label[0] || '?').toUpperCase()}
          </AvatarFallback>
        </Avatar>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Skeleton + empty state

function CommonSkeleton() {
  return (
    <div className="p-4 space-y-6">
      <Skeleton className="h-3 w-28" />
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <div className="flex items-center gap-2 mb-2">
            <Skeleton className="h-3 w-20" />
            <div className="flex-1 h-px bg-border/60" />
          </div>
          <div className="-mx-4 space-y-0">
            {[0, 1].map((j) => (
              <div key={j} className="flex items-center gap-3 px-4 py-2">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-2.5 w-1/4" />
                </div>
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
