/**
 * Recordings: the list of sessions that have a recording, with the plan's
 * filters kept in the URL (so a funnel drop-off or a frustration chart can
 * link straight to the people behind it), favourites, and an AI summary of the
 * sessions the current filter matches.
 */

import { useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MonitorPlay, Sparkles, Star } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_SESSION_SORTS, type PanelSessionRow, type RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useWeldPanelRecordings } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { DateRangePicker } from '../components/date-range-picker';
import { FreshnessBadge } from '../components/freshness-badge';
import { QueryErrorState } from '../components/query-error-state';
import { countryName, formatDateTime, formatDuration } from '../lib/format';
import { recordingsHref } from '../lib/links';
import { visitorLabel } from '../lib/people';
import { activeFilterCount, cleanSearch, parseRecordingsSearch, recordingsSpec, searchRange, withRange } from '../lib/recordings-search';
import { useProjectParam } from '../lib/use-project-param';
import { RecordingsFilters } from './filters';
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
    <AnalyticsPage title={to.title} description={to.description}>
      {(project) => (canWatch ? <RecordingsList project={project} search={search} /> : <EmptyState icon={MonitorPlay} title={to.title} description={to.noRecordingsPermission} />)}
    </AnalyticsPage>
  );
}

function RecordingsList({ project, search }: Readonly<{ project: PanelProjectDto; search: RecordingsSearch }>) {
  const { t, language, format } = useI18n();
  const to = t.weldpanel.observe.recordings;
  const router = useRouter();
  const [summaryOpen, setSummaryOpen] = useState(false);
  // The project in the URL is only an entry point: from here on the project bar decides.
  const effective = useMemo(() => cleanSearch({ ...search, project: undefined }), [search]);
  const spec = useMemo(() => recordingsSpec(effective, project.id), [effective, project.id]);
  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useWeldPanelRecordings(spec);
  const filterCount = activeFilterCount(search);
  const sessions = data?.sessions ?? [];
  const canSummarise = project.settings.aiEnabled;

  const update = (next: RecordingsSearch) => router.replace(recordingsHref(cleanSearch(next)));
  const open = (session: PanelSessionRow) => router.push(`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(project.id)}`);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={searchRange(search)} onChange={(range) => update(withRange(search, range))} />
        <RecordingsFilters projectId={project.id} search={search} onChange={update} />
        <Select value={search.sort ?? 'started_desc'} onValueChange={(sort) => update({ ...search, sort: sort as RecordingsSearch['sort'] })}>
          <SelectTrigger size="sm" className="h-8 w-44" aria-label={to.filters.sort}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PANEL_SESSION_SORTS.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {to.filters.sorts[sort]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filterCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => update({ range: search.range, from: search.from, to: search.to, sort: search.sort })}>
            {to.clearFilters}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <FreshnessBadge dataAsOf={data?.dataAsOf ?? undefined} fetching={isFetching} onRefresh={() => void refetch()} />
          {canSummarise && (
            <Button type="button" variant="outline" size="sm" disabled={sessions.length === 0} onClick={() => setSummaryOpen(true)}>
              <Sparkles />
              {to.summariseSet.button}
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-2" role="status" aria-label={t.common.labels.loading}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={MonitorPlay}
          title={filterCount > 0 ? to.emptyFilteredTitle : to.emptyTitle}
          description={filterCount > 0 ? to.emptyFilteredDescription : to.emptyDescription}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{to.columns.person}</TableHead>
                  <TableHead>{to.columns.started}</TableHead>
                  <TableHead>{to.columns.duration}</TableHead>
                  <TableHead>{to.columns.pages}</TableHead>
                  <TableHead>{to.columns.signals}</TableHead>
                  <TableHead>{to.columns.entry}</TableHead>
                  <TableHead>{to.columns.where}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const name = visitorLabel(session, t.weldpanel.observe.common.anonymous);
                  return (
                    <TableRow key={session.sessionId} className="cursor-pointer" onClick={() => open(session)}>
                      <TableCell>
                        {session.favorite ? <Star className="size-4 fill-amber-400 text-amber-500" aria-label={to.favorite} /> : null}
                      </TableCell>
                      <TableCell className="max-w-56 font-medium">
                        <Link
                          href={`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(project.id)}`}
                          className="block truncate hover:underline"
                          aria-label={format(to.open, { name })}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {name}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(session.startedAt, language)}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatDuration(session.durationSeconds)}</TableCell>
                      <TableCell className="tabular-nums">{session.pageviews}</TableCell>
                      <TableCell>
                        <SignalBadges session={session} />
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-muted-foreground" title={session.entryPage ?? undefined}>
                        {session.entryPage ?? '–'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {[session.deviceType ? t.weldpanel.observe.common.devices[session.deviceType] : null, session.browser, session.country ? countryName(session.country, language) : null]
                          .filter(Boolean)
                          .join(' · ') || '–'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{format(to.count, { count: sessions.length })}</p>
            {hasNextPage && (
              <Button type="button" variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {isFetchingNextPage ? t.weldpanel.observe.common.loadingMore : t.weldpanel.observe.common.loadMore}
              </Button>
            )}
          </div>
        </>
      )}

      {canSummarise && <SetSummaryDialog projectId={project.id} spec={spec} open={summaryOpen} onOpenChange={setSummaryOpen} />}
    </div>
  );
}
