/**
 * WeldDesk → Reports → Wallboard: the live queue for a screen on the wall
 * (TASK-1230). Big numbers, few words. Refetches every 15 seconds and when a
 * conversation or the phone queue changes; a failed refresh keeps the last
 * numbers on screen and says so.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  CheckCircle2,
  Clock,
  Hourglass,
  Inbox,
  Maximize2,
  Minimize2,
  ShieldAlert,
  ShieldCheck,
  Timer,
  UserX,
  Sparkles,
} from 'lucide-react';
import { useRealtimeEvent } from '@weldsuite/realtime/react';
import { Link, useSearchParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useDeskWallboard } from '@/hooks/queries/use-desk-reports-queries';
import type { DeskWallboard } from '@weldsuite/core-api-client/schemas/helpdesk-live-reports';
import { formatClock, liveSeconds, countdownTo } from '../lib/wallboard-format';
import { formatDuration } from '../lib/report-labels';
import { useThrottledCallback } from './use-throttled-callback';

type WallboardT = ReturnType<typeof useI18n>['t']['helpdesk']['wallboard'];
type ReportsT = ReturnType<typeof useI18n>['t']['helpdesk']['reports'];

const ALL_TEAMS = '__all__';
/** Realtime events refetch at most this often. */
const REALTIME_REFETCH_MS = 2_000;

/** The current time, ticking once a second so waits and countdowns run live. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Tiles({ data, now, t, tr }: Readonly<{ data: DeskWallboard; now: number; t: WallboardT; tr: ReportsT }>) {
  const { queue, sla, today } = data;
  const longestWait = liveSeconds(queue.oldestWaitingSeconds, data.generatedAt, now);
  return (
    <div className="space-y-4">
      <KpiGrid className="lg:grid-cols-4">
        <KpiCard size="large" label={t.tiles.open} icon={Inbox} value={queue.open.toLocaleString()} />
        <KpiCard size="large" label={t.tiles.unassigned} icon={UserX} value={queue.unassigned.toLocaleString()} />
        <KpiCard size="large" label={t.tiles.waiting} icon={Hourglass} value={queue.waiting.toLocaleString()} />
        <KpiCard size="large" label={t.tiles.longestWait} icon={Clock} value={formatClock(longestWait, tr)} />
      </KpiGrid>
      <KpiGrid className="lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          size="large"
          label={t.tiles.slaBreached}
          icon={ShieldAlert}
          tone={sla.breached > 0 ? 'danger' : 'default'}
          value={sla.breached.toLocaleString()}
        />
        <KpiCard
          size="large"
          label={t.tiles.slaAtRisk}
          icon={ShieldCheck}
          tone={sla.atRisk > 0 ? 'warning' : 'default'}
          value={sla.atRisk.toLocaleString()}
        />
        <KpiCard size="large" label={t.tiles.newToday} icon={Sparkles} value={today.created.toLocaleString()} />
        <KpiCard size="large" label={t.tiles.resolvedToday} icon={CheckCircle2} value={today.resolved.toLocaleString()} />
        <KpiCard
          size="large"
          label={t.tiles.firstResponseMedian}
          icon={Timer}
          value={formatDuration(today.firstResponseMedianSeconds, tr)}
        />
      </KpiGrid>
    </div>
  );
}

/** The badge tone of a due SLA: red once breached or overdue, amber when at risk. */
function dueTone(status: DeskWallboard['sla']['dueSoon'][number]['status'], overdue: boolean): 'danger' | 'warning' | 'neutral' {
  if (status === 'breached' || overdue) return 'danger';
  return status === 'warning' ? 'warning' : 'neutral';
}

function DueNext({ data, now, t, tr }: Readonly<{ data: DeskWallboard; now: number; t: WallboardT; tr: ReportsT }>) {
  const rows = data.sla.dueSoon;
  return (
    <SectionCard title={t.dueNext.title}>
      {rows.length === 0 ? (
        <EmptyText>{t.dueNext.empty}</EmptyText>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const { overdue, seconds } = countdownTo(row.dueAt, now);
            const time = formatClock(seconds, tr);
            const tone = dueTone(row.status, overdue);
            const metric = row.metric ? (tr.labels.slaMetric as Record<string, string>)[row.metric] ?? row.metric : null;
            return (
              <li key={row.conversationId}>
                <Link
                  href={`/welddesk/inbox/${row.conversationId}`}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-accent/40"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-lg font-medium">
                      <span className="tabular-nums text-muted-foreground">
                        {t.dueNext.conversation.replace('{number}', String(row.conversationNumber))}
                      </span>{' '}
                      {row.name}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {[metric, row.assigneeName ?? t.dueNext.unassigned].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <SoftBadge tone={tone} className="shrink-0 px-3 py-1 text-lg tabular-nums">
                    {(overdue ? t.dueNext.overdueBy : t.dueNext.dueIn).replace('{time}', time)}
                  </SoftBadge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function PhoneBlock({
  phone,
  generatedAt,
  now,
  t,
  tr,
}: Readonly<{ phone: NonNullable<DeskWallboard['phone']>; generatedAt: string; now: number; t: WallboardT; tr: ReportsT }>) {
  const longestWait = liveSeconds(phone.longestWaitSeconds, generatedAt, now);
  const items: Array<{ label: string; value: string; tone?: 'warning' }> = [
    { label: t.phone.waiting, value: phone.waiting.toLocaleString(), tone: phone.waiting > 0 ? 'warning' : undefined },
    { label: t.phone.longestWait, value: formatClock(longestWait, tr) },
    { label: t.phone.availableAgents, value: phone.availableAgents.toLocaleString() },
    { label: t.phone.answeredToday, value: phone.answeredToday.toLocaleString() },
    { label: t.phone.missedToday, value: phone.missedToday.toLocaleString() },
    { label: t.phone.abandonedToday, value: phone.abandonedToday.toLocaleString() },
  ];
  return (
    <SectionCard title={t.phone.title}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="space-y-1">
            <dt className="text-sm text-muted-foreground">
              {item.label}
            </dt>
            <dd
              className={cn(
                'text-4xl font-bold tabular-nums',
                item.tone === 'warning' && 'text-amber-600 dark:text-amber-400',
              )}
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function TeamLoad({ teams, t }: Readonly<{ teams: DeskWallboard['teams']; t: WallboardT }>) {
  return (
    <SectionCard title={t.teams.title}>
      {teams.length === 0 ? (
        <EmptyText>{t.teams.empty}</EmptyText>
      ) : (
        <table className="w-full text-lg">
          <thead>
            <tr className="text-left text-sm text-muted-foreground">
              <th className="pb-2 font-medium">{t.teams.name}</th>
              <th className="pb-2 text-right font-medium">{t.teams.open}</th>
              <th className="pb-2 text-right font-medium">{t.teams.unassigned}</th>
              <th className="pb-2 text-right font-medium">{t.teams.waiting}</th>
              <th className="pb-2 text-right font-medium">{t.teams.breached}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {teams.map((team) => (
              <tr key={team.id}>
                <td className="py-2 font-medium">{team.name}</td>
                <td className="py-2 text-right tabular-nums">{team.open.toLocaleString()}</td>
                <td className="py-2 text-right tabular-nums">{team.unassigned.toLocaleString()}</td>
                <td className="py-2 text-right tabular-nums">{team.waiting.toLocaleString()}</td>
                <td
                  className={cn(
                    'py-2 text-right tabular-nums',
                    team.breached > 0 && 'font-semibold text-destructive',
                  )}
                >
                  {team.breached.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function AgentLoad({ agents, t }: Readonly<{ agents: DeskWallboard['agents']; t: WallboardT }>) {
  const max = Math.max(...agents.map((agent) => agent.open), 1);
  return (
    <SectionCard title={t.agents.title}>
      {agents.length === 0 ? (
        <EmptyText>{t.agents.empty}</EmptyText>
      ) : (
        <ul className="space-y-3">
          {agents.map((agent) => (
            <li key={agent.id} className={cn('space-y-1', agent.away && 'opacity-60')}>
              <div className="flex items-center justify-between gap-3 text-lg">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{agent.name}</span>
                  {agent.away && <SoftBadge tone="neutral">{t.agents.away}</SoftBadge>}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {t.agents.open.replace('{count}', agent.open.toLocaleString())}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted">
                <div className="h-2 rounded-full bg-primary" style={{ width: `${(agent.open / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export default function DeskWallboardPage() {
  const { t } = useI18n();
  const tw = t.helpdesk.wallboard;
  const tr = t.helpdesk.reports;
  const searchParams = useSearchParams();
  const navigate = useNavigate();
  const teamId = searchParams.get('team') || null;

  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const { data, isLoading, isError, refetch } = useDeskWallboard(teamId);
  const now = useNow();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tr.title, href: '/welddesk/reports' },
    { label: tw.title },
  ]);

  // Realtime: conversations and the phone queue change the board; collapse a
  // burst of events into one refetch every couple of seconds.
  const refetchNow = useThrottledCallback(() => void refetch(), REALTIME_REFETCH_MS);
  useRealtimeEvent('desk_conversation', 'updated', refetchNow);
  useRealtimeEvent('desk_conversation', 'created', refetchNow);
  useRealtimeEvent('desk_message', 'created', refetchNow);
  useRealtimeEvent('desk_phone_queue', 'updated', refetchNow);

  // Teams seen so far: a filtered response only lists the chosen team, and the
  // picker must still offer the others.
  const [knownTeams, setKnownTeams] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!data) return;
    setKnownTeams((current) => {
      const byId = new Map(current.map((team) => [team.id, team]));
      for (const team of data.teams) byId.set(team.id, { id: team.id, name: team.name });
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, [data]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void rootRef.current?.requestFullscreen().catch(() => undefined);
    }
  }, []);

  const selectTeam = useCallback(
    (value: string | null) => {
      void navigate({
        to: '/welddesk/reports/wallboard',
        search: value ? { team: value } : {},
        replace: true,
      });
    },
    [navigate],
  );

  let body: ReactNode;
  if (!data && isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (!data) {
    body = (
      <div className="space-y-3">
        <ErrorState message={tw.loadError} onRetry={() => void refetch()} />
        {teamId && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => selectTeam(null)}>
              {tw.showAllTeams}
            </Button>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <>
        {isError && (
          <InfoBanner variant="warning" data-testid="wallboard-stale">
            {tw.stale.replace('{time}', formatTime(data.generatedAt))}
          </InfoBanner>
        )}
        <Tiles data={data} now={now} t={tw} tr={tr} />
        <div className="grid gap-6 lg:grid-cols-2">
          <DueNext data={data} now={now} t={tw} tr={tr} />
          {data.phone && <PhoneBlock phone={data.phone} generatedAt={data.generatedAt} now={now} t={tw} tr={tr} />}
          <TeamLoad teams={data.teams} t={tw} />
          <AgentLoad agents={data.agents} t={tw} />
        </div>
      </>
    );
  }

  const FullscreenIcon = fullscreen ? Minimize2 : Maximize2;
  const teamOptions =
    teamId && !knownTeams.some((team) => team.id === teamId) ? [...knownTeams, { id: teamId, name: teamId }] : knownTeams;

  return (
    <div ref={rootRef} className="h-full overflow-y-auto bg-background text-foreground">
      <div className="container mx-auto max-w-[1800px] space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-3xl font-semibold">{tw.title}</h1>
            <p className="text-sm text-muted-foreground">
              {data ? tw.updatedAt.replace('{time}', formatTime(data.generatedAt)) : tw.description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={teamId ?? ALL_TEAMS} onValueChange={(value) => selectTeam(value === ALL_TEAMS ? null : value)}>
              <SelectTrigger size="sm" aria-label={tw.teamFilter} className="h-8 w-auto min-w-[10rem] shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TEAMS}>{tw.allTeams}</SelectItem>
                {teamOptions.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={toggleFullscreen}>
              <FullscreenIcon className="mr-2 h-4 w-4" aria-hidden />
              {fullscreen ? tw.exitFullscreen : tw.fullscreen}
            </Button>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
