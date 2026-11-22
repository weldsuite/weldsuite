/**
 * The live view, laid out like a realtime analytics overview but flat, in
 * full-width sections divided by lines (no cards): a world map with a dot per
 * country; the visitors in the last 30 and 5 minutes, the time on site and
 * the pages per visit; the top countries,
 * pages and devices of the last 30 minutes side by side; then those sessions
 * as the standard list. Polls through `useWeldPanelLive` (every 15 seconds).
 * Without `panel_people:read` the API sends pseudonymised ids, which are
 * shown as anonymous visitors.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelLiveDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { FigureRow } from '@weldsuite/ui/components/figure-row';
import { RankedBars } from '@weldsuite/ui/components/ranked-bars';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { WorldMap } from '@weldsuite/ui/components/world-map';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useWeldPanelLive } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { QueryErrorState } from '../components/query-error-state';
import { countryName, formatDuration, formatNumber } from '../lib/format';
import { visitorLabel } from '../lib/people';

/**
 * Counts per key, biggest first. With `unique`, each key counts distinct
 * values of it (visitors, not sessions).
 */
export function tally<T>(items: readonly T[], key: (item: T) => string | null, unique?: (item: T) => string): { value: string; count: number }[] {
  const seen = new Map<string, Set<string>>();
  items.forEach((item, index) => {
    const k = key(item);
    if (!k) return;
    const set = seen.get(k) ?? new Set<string>();
    set.add(unique ? unique(item) : String(index));
    seen.set(k, set);
  });
  return [...seen.entries()].map(([value, set]) => ({ value, count: set.size })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** One of the three lists side by side: a heading over its content, on the page itself. */
function Part({ title, children }: Readonly<{ title?: string; children: ReactNode }>) {
  return (
    <section className="grid content-start gap-3 bg-background p-4" aria-label={title}>
      {title && <h2 className="text-sm font-medium">{title}</h2>}
      {children}
    </section>
  );
}

interface BreakdownProps {
  title: string;
  /** The first column's name ("Country"). */
  dimension: string;
  rows: { value: string; count: number }[];
  label?: (value: string) => string;
  loading: boolean;
}

/** A top list: the #1 with its count and share, then every row as a ranked bar. */
function Breakdown({ title, dimension, rows, label = (value) => value, loading }: Readonly<BreakdownProps>) {
  const { t, language, format } = useI18n();
  const tl = t.weldpanel.observe.live;
  const [all, setAll] = useState(false);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const top = rows[0];
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <Part title={title}>
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="grid gap-0.5">
        <p className="truncate text-xs text-muted-foreground">{format(t.weldpanel.observe.common.rankTop, { name: top ? label(top.value) : '–' })}</p>
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{formatNumber(top?.count ?? 0, language)}</span>
          {top && <span className="text-sm text-muted-foreground tabular-nums">{percent.format(top.count / total)}</span>}
        </p>
      </div>
      <div className="flex items-center justify-between border-b pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{dimension}</span>
        <span>{tl.activeVisitors}</span>
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{tl.noData}</p>
      ) : (
        <RankedBars
          items={rows.map((row) => ({ key: row.value, label: label(row.value), value: row.count, display: formatNumber(row.count, language) }))}
          limit={all ? undefined : 5}
          onShowAll={() => setAll(true)}
          showAllLabel={format(t.weldpanel.observe.common.showAll, { count: rows.length })}
          label={title}
        />
      )}
        </>
      )}
    </Part>
  );
}

/** A live session's row: `id` is the session id, so the list can key it. */
type LiveSessionRow = PanelLiveDto['sessions'][number] & { id: string };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

/** The value a sessions filter looks at. */
function sessionField(session: PanelLiveDto['sessions'][number], field: string): string | null {
  if (field === 'country') return session.country;
  if (field === 'device') return session.deviceType;
  if (field === 'page') return session.path;
  return null;
}

/** Whether a session passes one complete pill (`is` / `is not`); an unfinished pill lets everything through. */
export function matchesSessionFilter(session: PanelLiveDto['sessions'][number], filter: ActiveFilter): boolean {
  if (!filter.value) return true;
  const hit = sessionField(session, filter.field) === filter.value;
  return filter.operator === 'is not' ? !hit : hit;
}

/**
 * How long a visit of the last 30 minutes lasted so far (start to last
 * activity, in seconds) and how many pages it saw, on average. Over the
 * sessions answered (the 500 latest), which is plenty for an average.
 */
export function sessionAverages(sessions: readonly Pick<PanelLiveDto['sessions'][number], 'startedAt' | 'ts' | 'pageviews'>[]): { seconds: number; pages: number } {
  if (sessions.length === 0) return { seconds: 0, pages: 0 };
  const millis = sessions.reduce((sum, s) => sum + (Math.max(0, Date.parse(s.ts) - Date.parse(s.startedAt)) || 0), 0);
  const pages = sessions.reduce((sum, s) => sum + s.pageviews, 0);
  return { seconds: millis / sessions.length / 1000, pages: pages / sessions.length };
}

/** Whole minutes since `ts`. */
function minutesSince(ts: string, now: number): number {
  return Math.floor(Math.max(0, now - Date.parse(ts)) / 60_000);
}

function SessionsList({ live, canSeePeople }: Readonly<{ live: PanelLiveDto; canSeePeople: boolean }>) {
  const { t, language, format } = useI18n();
  const tl = t.weldpanel.observe.live;
  const now = Date.now();
  const devices = t.weldpanel.observe.common.devices;
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const rows = useMemo<LiveSessionRow[]>(
    () =>
      live.sessions
        .filter((session) => activeFilters.every((filter) => matchesSessionFilter(session, filter)))
        .map((session) => ({ ...session, id: session.sessionId })),
    [live.sessions, activeFilters],
  );
  // The pickers offer what the sessions of the last 30 minutes hold.
  const filters = useMemo<FilterConfig[]>(() => {
    const distinct = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => !!value))];
    const countries = distinct(live.sessions.map((s) => s.country))
      .map((code) => ({ value: code, label: countryName(code, language) }))
      .sort((a, b) => a.label.localeCompare(b.label, language));
    const pages = distinct(live.sessions.map((s) => s.path)).sort().map((path) => ({ value: path, label: path }));
    return [
      { field: 'country', label: tl.where, options: countries, searchable: true },
      { field: 'page', label: tl.page, options: pages, searchable: true },
      { field: 'device', label: tl.device, options: (['desktop', 'mobile', 'tablet'] as const).map((value) => ({ value, label: devices[value] })) },
    ];
  }, [live.sessions, language, tl, devices]);
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
      width: 'hidden sm:block sm:w-[240px]',
      render: (session) => (
        <span className="block truncate text-muted-foreground" title={session.title ?? undefined}>
          {session.path}
        </span>
      ),
    },
    {
      id: 'where',
      header: tl.where,
      width: 'hidden md:block md:w-[150px]',
      render: (session) => <span className="block truncate text-muted-foreground">{session.country ? countryName(session.country, language) : '–'}</span>,
    },
    {
      id: 'since',
      header: tl.since,
      width: 'hidden sm:block sm:w-[100px]',
      render: (session) => (
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(Math.max(0, (Date.parse(session.ts) - Date.parse(session.startedAt)) / 1000))}</span>
      ),
    },
    {
      id: 'last',
      header: tl.lastActive,
      width: 'w-[100px]',
      render: (session) => {
        const minutes = minutesSince(session.ts, now);
        return <span className="whitespace-nowrap tabular-nums text-muted-foreground">{minutes < 1 ? tl.now : format(tl.minutesAgo, { count: minutes })}</span>;
      },
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
    <section aria-label={tl.sessions}>
      <h2 className="sr-only">{tl.sessions}</h2>
      {/* The standard list: its toolbar row (Filter, search) over the header and rows. */}
      <PanelEntityList<LiveSessionRow>
        items={rows}
        isLoading={false}
        columns={columns}
        filters={filters}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchPlaceholder={tl.searchSessions}
        searchFields={['distinctId', 'path']}
        emptyState={{ title: tl.quiet, description: tl.quietHint }}
        noResultsState={{ title: tl.noMatchTitle, description: tl.noMatchDescription }}
      />
      {!canSeePeople && <p className="px-4 py-3 text-xs text-muted-foreground">{tl.pseudonymised}</p>}
    </section>
  );
}

export function LivePanel({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tl = t.weldpanel.observe.live;
  const devices = t.weldpanel.observe.common.devices;
  const canSeePeople = useCan('panel_people:read');
  const { data: live, error, isLoading, refetch } = useWeldPanelLive(projectId);
  const averages = useMemo(() => sessionAverages(live?.sessions ?? []), [live?.sessions]);
  const oneDecimal = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });

  const breakdowns = useMemo(() => {
    const sessions = live?.sessions ?? [];
    const visitor = (session: PanelLiveDto['sessions'][number]) => session.distinctId;
    return {
      countries: tally(sessions, (s) => s.country, visitor),
      pages: tally(sessions, (s) => s.path, visitor),
      devices: tally(sessions, (s) => s.deviceType, visitor),
    };
  }, [live?.sessions]);

  if (error) return <QueryErrorState className="p-6" error={error} onRetry={() => void refetch()} />;

  const country = (code: string) => countryName(code, language);
  return (
    <div data-testid="live-panel">
      {/* The map across the page, at its own shape (shorter on very wide screens). */}
      <section aria-label={tl.byCountry} className="border-b">
        <WorldMap
          items={breakdowns.countries.map((row) => ({ code: row.value, label: country(row.value), value: row.count, display: formatNumber(row.count, language) }))}
          valueLabel={tl.activeVisitors}
          countryLabel={tl.where}
          label={tl.byCountry}
          zoom={{ zoomIn: tl.zoomIn, zoomOut: tl.zoomOut, reset: tl.zoomReset }}
          className="aspect-[1000/547] max-h-[560px] w-full"
        />
      </section>

      {/* The figures across the page, as on the WeldBooks dashboard. */}
      <section aria-label={tl.activeVisitors} className="border-b p-4">
        <FigureRow
          columns={4}
          loading={isLoading}
          items={[
            { key: '30m', label: tl.activeVisitors, value: formatNumber(live?.visitors30m ?? live?.visitors ?? 0, language), note: tl.last30Note },
            { key: '5m', label: tl.rightNow, value: formatNumber(live?.visitors ?? 0, language), note: tl.last5Note },
            { key: 'time', label: tl.timeOnSite, value: formatDuration(averages.seconds), note: tl.timeOnSiteNote },
            { key: 'pages', label: tl.pagesPerVisit, value: oneDecimal.format(averages.pages), note: tl.pagesPerVisitNote },
          ]}
        />
      </section>

      {/* The three lists side by side; the row's gap shows its border colour between them. */}
      <div className="grid gap-px border-b bg-border md:grid-cols-3">
        <Breakdown title={tl.byCountry} dimension={tl.where} rows={breakdowns.countries} label={country} loading={isLoading} />
        <Breakdown title={tl.byPage} dimension={tl.page} rows={breakdowns.pages} loading={isLoading} />
        <Breakdown title={tl.byDevice} dimension={tl.device} rows={breakdowns.devices} label={(value) => devices[value as keyof typeof devices] ?? value} loading={isLoading} />
      </div>

      {live && <SessionsList live={live} canSeePeople={canSeePeople} />}
    </div>
  );
}
