/**
 * Users: everyone the project has seen, as the standard list (toolbar with
 * cohort filter, search and CSV export, a column header, one row per person).
 * A row opens the person in the shared record panel (`panel_person`).
 */

import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useWeldPanelCohorts, useWeldPanelPeople } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { PANEL_PERSON_TYPE, panelPersonId } from '@/components/objects/panel-person/panel-person-tabs';
import { AnalyticsListPage } from '../components/analytics-page';
import { CsvExportButton } from '../components/chart-card';
import { QueryErrorState } from '../components/query-error-state';
import { csvFilename } from '../lib/csv';
import { formatDate } from '../lib/format';
import { personDisplayName } from '../lib/people';

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

/** A person's row: `id` is the distinct id, so the list can key and click it. */
type PersonRow = PanelPersonDto & { id: string };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

export default function UsersPage() {
  const { t } = useI18n();
  const canRead = useCan('panel_people:read');
  const tu = t.weldpanel.observe.users;
  return (
    <AnalyticsListPage title={tu.title}>
      {(project) => (canRead ? <UsersList project={project} /> : <EmptyState icon={Users} title={tu.title} description={t.weldpanel.observe.common.noPermission} />)}
    </AnalyticsListPage>
  );
}

function UsersList({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language } = useI18n();
  const tu = t.weldpanel.observe.users;
  // The open person panel is kept in the URL (`?stack=`), so it survives a reload and can be linked to.
  useObjectPanelUrlSync('/weldpanel/users');
  const { open: openPanel } = useObjectPanel();
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const debounced = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  // One cohort at a time: the API filters on a single cohort.
  const cohortId = activeFilters.find((f) => f.field === 'cohortId' && f.value)?.value;
  const params = useMemo(
    () => ({ projectId: project.id, search: debounced || undefined, cohortId, limit: 50 }),
    [project.id, debounced, cohortId],
  );
  const { data: cohorts } = useWeldPanelCohorts(project.id);
  const { data, error, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useWeldPanelPeople(params);
  const people = useMemo<PersonRow[]>(() => (data?.people ?? []).map((person) => ({ ...person, id: person.userId })), [data]);

  const filters = useMemo<FilterConfig[]>(
    () =>
      cohorts && cohorts.length > 0
        ? [{ field: 'cohortId', label: tu.cohort, options: cohorts.map((cohort) => ({ value: cohort.id, label: cohort.name })) }]
        : [],
    [cohorts, tu.cohort],
  );

  const columns: ColumnDef<PersonRow>[] = [
    {
      id: 'person',
      header: tu.columns.person,
      width: 'flex-1 min-w-[180px]',
      render: (person) => {
        const name = personDisplayName(person);
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-6 w-6 shrink-0">
              <AvatarFallback className="bg-gray-200 text-[10px] font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground">
                {initials(name)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">{name}</span>
          </div>
        );
      },
    },
    {
      id: 'email',
      header: tu.columns.email,
      width: 'hidden md:block md:w-[260px]',
      render: (person) => <span className="block truncate text-muted-foreground">{person.email ?? '–'}</span>,
    },
    {
      id: 'lastSeen',
      header: tu.columns.lastSeen,
      width: 'w-[120px]',
      render: (person) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(person.lastSeen, language)}</span>,
    },
    {
      id: 'firstSeen',
      header: tu.columns.firstSeen,
      width: 'hidden lg:block lg:w-[120px]',
      render: (person) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(person.firstSeen, language)}</span>,
    },
    {
      id: 'properties',
      header: tu.columns.properties,
      width: 'hidden sm:block sm:w-[90px] text-right',
      headerClassName: 'text-right',
      render: (person) => <span className="tabular-nums">{Object.keys(person.properties).length}</span>,
    },
  ];

  // The shared list words its own first-load state in English only.
  if (isLoading && !data) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  return (
    <>
      {error && (
        <div className="px-4 pt-4">
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        </div>
      )}
      <PanelEntityList<PersonRow>
        items={people}
        isLoading={false}
        columns={columns}
        filters={filters}
        hideFilter={filters.length === 0}
        activeFilters={activeFilters}
        onFiltersChange={setActiveFilters}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={tu.searchPlaceholder}
        actionButtons={
          people.length > 0 ? (
            // The people loaded so far (this page and any "load more"), not the whole project.
            <CsvExportButton
              csv={() => ({
                filename: csvFilename(`${project.name} ${tu.title}`),
                rows: people.map((person) => ({ distinct_id: person.userId, name: person.name, email: person.email, first_seen: person.firstSeen, last_seen: person.lastSeen })),
              })}
            />
          ) : undefined
        }
        onRowClick={(person) => openPanel({ type: PANEL_PERSON_TYPE, id: panelPersonId(project.id, person.userId) })}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        emptyState={{ icon: <Users className="size-8 text-muted-foreground" />, title: tu.emptyTitle, description: tu.emptyDescription }}
        noResultsState={{ icon: <Users className="size-8 text-muted-foreground" />, title: tu.emptySearchTitle, description: tu.emptySearchDescription }}
      />
    </>
  );
}
