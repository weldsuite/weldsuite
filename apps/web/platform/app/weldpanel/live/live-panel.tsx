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
import { KpiCard } from '@weldsuite/ui/components/kpi-card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
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
      {!compact && live && <SessionsCard live={live} canSeePeople={canSeePeople} />}
    </>
  );
}

function SessionsCard({ live, canSeePeople }: Readonly<{ live: PanelLiveDto; canSeePeople: boolean }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.observe.live;
  const now = Date.now();
  return (
    <ChartCard title={tl.sessions}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tl.session}</TableHead>
              <TableHead>{tl.page}</TableHead>
              <TableHead>{tl.where}</TableHead>
              <TableHead>{tl.since}</TableHead>
              <TableHead className="text-right">{tl.pageviews}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {live.sessions.map((session) => (
              <TableRow key={session.sessionId}>
                <TableCell className="max-w-48 truncate font-medium">
                  {canSeePeople ? session.distinctId : visitorLabel({ userId: null, distinctId: session.distinctId }, t.weldpanel.observe.common.anonymous)}
                </TableCell>
                <TableCell className="max-w-64 truncate" title={session.title ?? undefined}>
                  {session.path}
                </TableCell>
                <TableCell>{session.country ? countryName(session.country, language) : '–'}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{formatDuration(Math.max(0, (now - Date.parse(session.startedAt)) / 1000))}</TableCell>
                <TableCell className="text-right tabular-nums">{session.pageviews}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!canSeePeople && <p className="mt-2 text-xs text-muted-foreground">{tl.pseudonymised}</p>}
    </ChartCard>
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
