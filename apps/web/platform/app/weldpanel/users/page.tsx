/** Users: everyone the project has seen, searchable and filterable by cohort, each row opening a profile. */

import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useWeldPanelCohorts, useWeldPanelPeople } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { QueryErrorState } from '../components/query-error-state';
import { formatDate, formatNumber } from '../lib/format';
import { personDisplayName } from '../lib/people';

const ALL = '__all__';
const SEARCH_DEBOUNCE_MS = 300;

/** The value after it has stopped changing for a moment, so typing does not fire a request per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function UsersPage() {
  const { t } = useI18n();
  const canRead = useCan('panel_people:read');
  const tu = t.weldpanel.observe.users;
  return (
    <AnalyticsPage title={tu.title} description={tu.description}>
      {(project) => (canRead ? <UsersList project={project} /> : <EmptyState icon={Users} title={tu.title} description={t.weldpanel.observe.common.noPermission} />)}
    </AnalyticsPage>
  );
}

function PersonRow({ person, projectId, onOpen }: Readonly<{ person: PanelPersonDto; projectId: string; onOpen: (userId: string) => void }>) {
  const { t, language, format } = useI18n();
  const tu = t.weldpanel.observe.users;
  const name = personDisplayName(person);
  return (
    <TableRow className="cursor-pointer" onClick={() => onOpen(person.userId)}>
      <TableCell className="max-w-64 font-medium">
        <Link
          href={`/weldpanel/users/${encodeURIComponent(person.userId)}?project=${encodeURIComponent(projectId)}`}
          className="block truncate hover:underline"
          aria-label={format(tu.openProfile, { name })}
          onClick={(event) => event.stopPropagation()}
        >
          {name}
        </Link>
      </TableCell>
      <TableCell className="max-w-64 truncate text-muted-foreground">{person.email ?? '–'}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(person.lastSeen, language)}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(person.firstSeen, language)}</TableCell>
      <TableCell className="text-right tabular-nums">{Object.keys(person.properties).length}</TableCell>
    </TableRow>
  );
}

function UsersList({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language, format } = useI18n();
  const tu = t.weldpanel.observe.users;
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [cohortId, setCohortId] = useState<string>(ALL);
  const debounced = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const params = useMemo(() => ({ projectId: project.id, search: debounced || undefined, cohortId: cohortId === ALL ? undefined : cohortId, limit: 50 }), [project.id, debounced, cohortId]);
  const { data: cohorts } = useWeldPanelCohorts(project.id);
  const { data, error, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useWeldPanelPeople(params);
  const people = data?.people ?? [];
  const filtered = debounced !== '' || cohortId !== ALL;
  const emptyCopy = filtered ? { title: tu.emptySearchTitle, description: tu.emptySearchDescription } : { title: tu.emptyTitle, description: tu.emptyDescription };

  const openProfile = (userId: string) => router.push(`/weldpanel/users/${encodeURIComponent(userId)}?project=${encodeURIComponent(project.id)}`);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="w-full sm:w-72" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tu.searchPlaceholder} aria-label={tu.searchLabel} />
        {cohorts && cohorts.length > 0 && (
          <Select value={cohortId} onValueChange={setCohortId}>
            <SelectTrigger size="sm" className="h-8 w-48" aria-label={tu.cohort}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tu.allCohorts}</SelectItem>
              {cohorts.map((cohort) => (
                <SelectItem key={cohort.id} value={cohort.id}>
                  {cohort.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {data && <span className="ml-auto text-sm text-muted-foreground">{format(tu.count, { count: formatNumber(data.totalCount, language) })}</span>}
      </div>

      {error && <QueryErrorState error={error} onRetry={() => void refetch()} />}
      {!error && isLoading && (
        <div className="grid gap-2" role="status" aria-label={t.common.labels.loading}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {!error && !isLoading && people.length === 0 && <EmptyState icon={Users} title={emptyCopy.title} description={emptyCopy.description} />}
      {!error && !isLoading && people.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tu.columns.person}</TableHead>
                  <TableHead>{tu.columns.email}</TableHead>
                  <TableHead>{tu.columns.lastSeen}</TableHead>
                  <TableHead>{tu.columns.firstSeen}</TableHead>
                  <TableHead className="text-right">{tu.columns.properties}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((person) => (
                  <PersonRow key={person.userId} person={person} projectId={project.id} onOpen={openProfile} />
                ))}
              </TableBody>
            </Table>
          </div>
          {hasNextPage && (
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {isFetchingNextPage ? t.weldpanel.observe.common.loadingMore : t.weldpanel.observe.common.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
