/**
 * "Right now": visitors on the site in the last five minutes, the pages they
 * are on, their countries and devices, and the active sessions. Polls through
 * `useWeldPanelLive` (every 15 seconds). Without `panel_people:read` the API
 * sends pseudonymised ids, which are shown as anonymous visitors.
 */

import { useMemo } from 'react';
import { Radio, Users } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelLiveDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { KpiCard } from '@weldsuite/ui/components/kpi-card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useWeldPanelLive } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ChartCard } from '../components/chart-card';
import { countryName, formatDuration, formatNumber } from '../lib/format';
import { visitorLabel } from '../lib/people';

/** Counts per key, biggest first. */
export function tally<T>(items: readonly T[], key: (item: T) => string | null): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function Breakdown({ title, rows, label }: Readonly<{ title: string; rows: { value: string; count: number }[]; label?: (value: string) => string }>) {
  const { t, language } = useI18n();
  return (
    <ChartCard title={title} empty={rows.length === 0} emptyText={t.weldpanel.observe.live.quiet}>
      <ul className="grid gap-1.5 text-sm">
        {rows.slice(0, 8).map((row) => (
          <li key={row.value} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">{label ? label(row.value) : row.value}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(row.count, language)}</span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

function liveSummary(live: PanelLiveDto | undefined, deviceLabels: Record<string, string>) {
  const sessions = live?.sessions ?? [];
  return {
    pages: tally(sessions, (s) => s.path),
    countries: tally(sessions, (s) => s.country),
    devices: tally(sessions, (s) => (s.deviceType ? (deviceLabels[s.deviceType] ?? s.deviceType) : null)),
  };
}

interface LiveBodyProps {
  live: PanelLiveDto | undefined;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
  summary: ReturnType<typeof liveSummary>;
  compact: boolean;
  canSeePeople: boolean;
}

function LiveBody({ live, error, isLoading, onRetry, summary, compact, canSeePeople }: Readonly<LiveBodyProps>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.observe.live;
  if (error) {
    return (
      <ChartCard error={error} onRetry={onRetry}>
        {null}
      </ChartCard>
    );
  }
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (live && live.visitors === 0) {
    return (
      <ChartCard>
        <div className="py-6 text-center">
          <p className="text-sm font-medium">{tl.quiet}</p>
          <p className="text-sm text-muted-foreground">{tl.quietHint}</p>
        </div>
      </ChartCard>
    );
  }
  return (
    <>
      <div className={`grid gap-4 ${compact ? '' : 'md:grid-cols-3'}`}>
        <Breakdown title={tl.currentPages} rows={summary.pages} />
        <Breakdown title={tl.countries} rows={summary.countries} label={(code) => countryName(code, language)} />
        <Breakdown title={tl.devices} rows={summary.devices} />
      </div>
      {!compact && live && <SessionsList live={live} canSeePeople={canSeePeople} />}
    </>
  );
}

/** A live session's row: `id` is the session id, so the list can key it. */
type LiveSessionRow = PanelLiveDto['sessions'][number] & { id: string };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

function SessionsList({ live, canSeePeople }: Readonly<{ live: PanelLiveDto; canSeePeople: boolean }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.observe.live;
  const now = Date.now();
  const rows = useMemo<LiveSessionRow[]>(() => live.sessions.map((session) => ({ ...session, id: session.sessionId })), [live.sessions]);
  const columns: ColumnDef<LiveSessionRow>[] = [
    {
      id: 'session',
      header: tl.session,
      width: 'flex-1 min-w-[180px]',
      render: (session) => {
        const name = canSeePeople ? session.distinctId : visitorLabel({ userId: null, distinctId: session.distinctId }, t.weldpanel.observe.common.anonymous);
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-6 w-6 shrink-0">
              <AvatarFallback className="bg-gray-200 text-[10px] font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground">{initials(name)}</AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">{name}</span>
          </div>
        );
      },
    },
    {
      id: 'page',
      header: tl.page,
      width: 'hidden sm:block sm:w-[260px]',
      render: (session) => (
        <span className="block truncate text-muted-foreground" title={session.title ?? undefined}>
          {session.path}
        </span>
      ),
    },
    {
      id: 'where',
      header: tl.where,
      width: 'hidden md:block md:w-[160px]',
      render: (session) => <span className="block truncate text-muted-foreground">{session.country ? countryName(session.country, language) : '–'}</span>,
    },
    {
      id: 'since',
      header: tl.since,
      width: 'w-[90px]',
      render: (session) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(Math.max(0, (now - Date.parse(session.startedAt)) / 1000))}</span>,
    },
    {
      id: 'pageviews',
      header: tl.pageviews,
      width: 'hidden sm:block sm:w-[90px] text-right',
      headerClassName: 'text-right',
      render: (session) => <span className="tabular-nums">{session.pageviews}</span>,
    },
  ];
  return (
    <section className="grid gap-2" aria-label={tl.sessions}>
      <h2 className="text-sm font-medium">{tl.sessions}</h2>
      <PanelEntityList<LiveSessionRow>
        items={rows}
        isLoading={false}
        columns={columns}
        hideTopBar
        emptyState={{ title: tl.quiet, description: tl.quietHint }}
      />
      {!canSeePeople && <p className="text-xs text-muted-foreground">{tl.pseudonymised}</p>}
    </section>
  );
}

export function LivePanel({ projectId, compact = false }: Readonly<{ projectId: string; compact?: boolean }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.observe.live;
  const canSeePeople = useCan('panel_people:read');
  const { data: live, error, isLoading, refetch, dataUpdatedAt } = useWeldPanelLive(projectId);
  const summary = useMemo(() => liveSummary(live, t.weldpanel.observe.common.devices), [live, t.weldpanel.observe.common.devices]);
  const updated = dataUpdatedAt ? new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(new Date(dataUpdatedAt)) : null;
  return (
    <div className="grid gap-4" data-testid="live-panel">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-start">
        <KpiCard label={tl.visitors} icon={Users} size="large" loading={isLoading} value={live ? formatNumber(live.visitors, language) : ''} hint={tl.visitorsHint} tone={live && live.visitors > 0 ? 'success' : 'default'} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Radio className="size-4 text-emerald-500" aria-hidden />
          {updated ? tl.updated.replace('{time}', updated) : null}
        </div>
      </div>

      <LiveBody live={live} error={error} isLoading={isLoading} onRetry={() => void refetch()} summary={summary} compact={compact} canSeePeople={canSeePeople} />
    </div>
  );
}
