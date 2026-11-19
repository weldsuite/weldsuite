/**
 * Recordings: the sessions that have a recording, as the standard list. Its
 * Filter pills are the plan's filters, kept in the URL (so a funnel drop-off
 * or a frustration chart can link straight to the people behind it); search
 * finds a visitor; the sort is the one picker next to Filter. Favourites are
 * set from the row menu, and the AI summary covers what the filters match.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MonitorPlay, Play, ScrollText, Star, StarOff } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_SESSION_SORTS, type PanelSessionRow, type RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { PanelEntityList, type ActiveFilter, type ColumnDef } from '@/components/panel-entity-list';
import { useFavoriteWeldPanelSession, useUnfavoriteWeldPanelSession, useWeldPanelCohorts, useWeldPanelLexicon, useWeldPanelRecordings } from '@/hooks/queries/use-weldpanel-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { QueryErrorState } from '../components/query-error-state';
import { countryName, formatDateTime, formatDuration } from '../lib/format';
import { recordingsHref } from '../lib/links';
import { visitorLabel } from '../lib/people';
import { activeFilterCount, cleanSearch, parseRecordingsSearch, recordingsSpec } from '../lib/recordings-search';
import { useProjectParam } from '../lib/use-project-param';
import { filtersToSearch, recordingsFilterConfigs, searchToFilters } from './filter-pills';
import { SetSummaryDialog } from './set-summary-dialog';
import { SignalBadges } from './signal-badges';

export default function RecordingsPage() {
  const { t } = useI18n();
  const canWatch = useCan('panel_recordings:read');
  const raw = useSearch({ strict: false });
  const search = useMemo(() => parseRecordingsSearch(raw), [raw]);
  useProjectParam(search.project);
  const to = t.weldpanel.observe.recordings;

  return (
    <AnalyticsListPage title={to.title}>
      {(project) => (canWatch ? <RecordingsList project={project} search={search} /> : <EmptyState icon={MonitorPlay} title={to.title} description={to.noRecordingsPermission} />)}
    </AnalyticsListPage>
  );
}

function whereText(session: PanelSessionRow, devices: Record<string, string>, language: string): string {
  return (
    [session.deviceType ? devices[session.deviceType] : null, session.browser, session.country ? countryName(session.country, language) : null].filter(Boolean).join(' · ') || '–'
  );
}

/** A recording's row: `id` is the session id, so the list can key and click it. */
type SessionListRow = PanelSessionRow & { id: string };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

function RecordingsList({ project, search }: Readonly<{ project: PanelProjectDto; search: RecordingsSearch }>) {
  const { t, language } = useI18n();
  const to = t.weldpanel.observe.recordings;
  const router = useRouter();
  const [summaryOpen, setSummaryOpen] = useState(false);
  // The project in the URL is only an entry point: from here on the project bar decides.
  const effective = useMemo(() => cleanSearch({ ...search, project: undefined }), [search]);
  const spec = useMemo(() => recordingsSpec(effective, project.id), [effective, project.id]);
  const { data, error, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useWeldPanelRecordings(spec);
  const { data: cohorts } = useWeldPanelCohorts(project.id);
  const { data: lexicon } = useWeldPanelLexicon(project.id);
  const favorite = useFavoriteWeldPanelSession(project.id);
  const unfavorite = useUnfavoriteWeldPanelSession(project.id);
  const filterCount = activeFilterCount(search);
  const sessions = useMemo<SessionListRow[]>(() => (data?.sessions ?? []).map((session) => ({ ...session, id: session.sessionId })), [data]);
  const canSummarise = project.settings.aiEnabled;
  const emptyCopy =
    filterCount > 0 ? { title: to.emptyFilteredTitle, description: to.emptyFilteredDescription } : { title: to.emptyTitle, description: to.emptyDescription };

  const update = (next: RecordingsSearch) => router.replace(recordingsHref(cleanSearch(next)));

  // Search finds a visitor (their user or anonymous id); the URL follows once typing pauses.
  const [query, setQuery] = useState(search.user ?? '');
  const debouncedQuery = useDebounce(query.trim(), 300);
  useEffect(() => {
    if ((search.user ?? '') !== debouncedQuery) update({ ...search, user: debouncedQuery || undefined });
    // Only a new query should write the URL, not every change of the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // The pills are the URL's filters; pills still being filled in live here until they are complete.
  const [draftPills, setDraftPills] = useState<ActiveFilter[] | null>(null);
  const urlPills = useMemo(() => searchToFilters(search), [search]);
  const pills = draftPills ?? urlPills;
  const onPillsChange = (next: ActiveFilter[]) => {
    const unfinished = next.some((pill) => !pill.operator || pill.value === '');
    setDraftPills(unfinished ? next : null);
    update(filtersToSearch(next, search));
  };
  const td = t.weldpanel.analytics.range;
  const tf = to.filters;
  const filterConfigs = recordingsFilterConfigs(
    search,
    {
      period: td.label,
      presets: { today: td.today, '7d': td['7d'], '30d': td['30d'], '90d': td['90d'], '12m': td['12m'] },
      customRange: (from, toDay) => `${formatDateTime(`${from}T00:00:00`, language).split(',')[0]} – ${formatDateTime(`${toDay}T00:00:00`, language).split(',')[0]}`,
      devices: tf.devices,
      deviceNames: t.weldpanel.observe.common.devices,
      countries: tf.countries,
      countryName: (code) => countryName(code, language),
      browsers: tf.browsers,
      frustration: tf.frustration,
      frustrationTypes: tf.frustrationTypes,
      errors: tf.errors,
      favorites: tf.favorites,
      cohort: tf.cohort,
      event: tf.did,
      entryPage: tf.entryPage,
      exitPage: tf.exitPage,
      page: tf.pagesVisited,
      minDuration: `${tf.duration}: ${tf.minDuration}`,
      maxDuration: `${tf.duration}: ${tf.maxDuration}`,
    },
    {
      cohorts: cohorts ?? [],
      events: (lexicon?.events ?? []).filter((event) => !event.hidden).map((event) => event.name),
      countries: sessions.map((session) => session.country ?? '').filter(Boolean),
      browsers: sessions.map((session) => session.browser ?? '').filter(Boolean),
    },
  );

  const toggleFavorite = async (session: PanelSessionRow) => {
    const tfav = t.weldpanel.observe.session.favorite;
    try {
      if (session.favorite) await unfavorite.mutateAsync(session.sessionId);
      else await favorite.mutateAsync({ sessionId: session.sessionId });
      toast.success(session.favorite ? tfav.removed : tfav.added);
    } catch {
      toast.error(tfav.failed);
    }
  };
  const open = (session: PanelSessionRow) => router.push(`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(project.id)}`);

  const columns: ColumnDef<SessionListRow>[] = [
    {
      id: 'person',
      header: to.columns.person,
      width: 'flex-1 min-w-[180px]',
      render: (session) => {
        const name = visitorLabel(session, t.weldpanel.observe.common.anonymous);
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-6 w-6 shrink-0">
              <AvatarFallback className="bg-gray-200 text-[10px] font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground">{initials(name)}</AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">{name}</span>
            {session.favorite && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-500" aria-label={to.favorite} />}
          </div>
        );
      },
    },
    {
      id: 'started',
      header: to.columns.started,
      width: 'hidden sm:block sm:w-[160px]',
      render: (session) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(session.startedAt, language)}</span>,
    },
    {
      id: 'duration',
      header: to.columns.duration,
      width: 'w-[80px]',
      render: (session) => <span className="whitespace-nowrap tabular-nums">{formatDuration(session.durationSeconds)}</span>,
    },
    {
      id: 'pages',
      header: to.columns.pages,
      width: 'hidden md:block md:w-[60px]',
      render: (session) => <span className="tabular-nums">{session.pageviews}</span>,
    },
    {
      id: 'signals',
      header: to.columns.signals,
      width: 'hidden lg:block lg:w-[220px]',
      // One line, like every row: the badges that don't fit are cut off.
      render: (session) => (
        <div className="flex min-w-0 flex-nowrap overflow-hidden [&>*]:flex-nowrap [&>*]:whitespace-nowrap">
          <SignalBadges session={session} />
        </div>
      ),
    },
    {
      id: 'entry',
      header: to.columns.entry,
      width: 'hidden xl:block xl:w-[200px]',
      render: (session) => (
        <span className="block truncate text-muted-foreground" title={session.entryPage ?? undefined}>
          {session.entryPage ?? '–'}
        </span>
      ),
    },
    {
      id: 'where',
      header: to.columns.where,
      width: 'hidden lg:block lg:w-[220px]',
      render: (session) => <span className="block truncate text-muted-foreground">{whereText(session, t.weldpanel.observe.common.devices, language)}</span>,
    },
  ];

  if (isLoading && !data && !error) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  return (
    <>
      {error && (
        <div className="px-4 pt-4">
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        </div>
      )}
      <PanelEntityList<SessionListRow>
        items={sessions}
        isLoading={false}
        columns={columns}
        filters={filterConfigs}
        activeFilters={pills}
        onFiltersChange={onPillsChange}
        searchQuery={query}
        onSearchChange={setQuery}
        searchPlaceholder={tf.userPlaceholder}
        leftActionButtons={
          <Select value={search.sort ?? 'started_desc'} onValueChange={(sort) => update({ ...search, sort: sort as RecordingsSearch['sort'] })}>
            <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 shadow-none" aria-label={tf.sort}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PANEL_SESSION_SORTS.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {tf.sorts[sort]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        actionButtons={
          canSummarise ? (
            <Button type="button" variant="outline" size="sm" className="h-8" disabled={sessions.length === 0} onClick={() => setSummaryOpen(true)}>
              <ScrollText />
              {to.summariseSet.button}
            </Button>
          ) : undefined
        }
        rowMenu={(session) => (
          <>
            <DropdownMenuItem onClick={() => open(session)}>
              <Play />
              {t.weldpanel.observe.person.watch}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void toggleFavorite(session)}>
              {session.favorite ? <StarOff /> : <Star />}
              {session.favorite ? t.weldpanel.observe.session.favorite.remove : t.weldpanel.observe.session.favorite.add}
            </DropdownMenuItem>
          </>
        )}
        onRowClick={(session) => open(session)}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        emptyState={{ icon: <MonitorPlay className="size-8 text-muted-foreground" />, title: emptyCopy.title, description: emptyCopy.description }}
        noResultsState={{ icon: <MonitorPlay className="size-8 text-muted-foreground" />, title: to.emptyFilteredTitle, description: to.emptyFilteredDescription }}
      />
      {canSummarise && <SetSummaryDialog projectId={project.id} spec={spec} open={summaryOpen} onOpenChange={setSummaryOpen} />}
    </>
  );
}
