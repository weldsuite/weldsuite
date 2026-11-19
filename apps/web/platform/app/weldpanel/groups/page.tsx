/** Groups: the companies (or other group types) the project's events belong to, per type, searchable, each row opening the group's record panel. */

import { useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelGroupDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useWeldPanelGroupTypes, useWeldPanelGroups } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { useSearchParams } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { QueryErrorState } from '../components/query-error-state';
import { formatDate } from '../lib/format';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { PANEL_GROUP_TYPE, panelGroupId } from '@/components/objects/panel-group/panel-group-tabs';

/** A group's row: `id` joins type and key, so the list can key and click it. */
type GroupRow = PanelGroupDto & { id: string };

const SEARCH_DEBOUNCE_MS = 300;

function GroupsList({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const params = useSearchParams();
  // The open group panel is kept in the URL (`?stack=`), so it survives a reload and can be linked to.
  useObjectPanelUrlSync('/weldpanel/groups');
  const { open: openPanel } = useObjectPanel();
  const { data: types, isLoading: typesLoading, isError: typesError, refetch: refetchTypes } = useWeldPanelGroupTypes(projectId);
  const [chosenType, setChosenType] = useState(params.get('type') ?? '');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const type = types?.some((g) => g.groupType === chosenType) ? chosenType : (types?.[0]?.groupType ?? '');
  const listParams = useMemo(() => ({ projectId, type, search: debounced || undefined, limit: 50 }), [projectId, type, debounced]);
  const { data, error, isLoading, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useWeldPanelGroups(listParams, type !== '');
  const groups = useMemo<GroupRow[]>(() => (data?.groups ?? []).map((group) => ({ ...group, id: `${group.groupType}:${group.groupKey}` })), [data]);
  const current = types?.find((g) => g.groupType === type);

  if (typesLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (typesError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetchTypes()} retryLabel={t.weldpanel.retry} />;
  if (!types || types.length === 0) return <EmptyState icon={Building2} title={tx.noTypesTitle} description={tx.noTypesDescription} />;

  const open = (group: PanelGroupDto) => openPanel({ type: PANEL_GROUP_TYPE, id: panelGroupId(projectId, group.groupType, group.groupKey) });

  const columns: ColumnDef<GroupRow>[] = [
    {
      id: 'name',
      header: tx.columns.name,
      width: 'flex-1 min-w-[180px]',
      render: (group) => <span className="block truncate font-medium">{group.name?.trim() || group.groupKey}</span>,
    },
    {
      id: 'key',
      header: tx.columns.key,
      width: 'hidden sm:block sm:w-[260px]',
      render: (group) => <span className="block truncate font-mono text-xs text-muted-foreground">{group.groupKey}</span>,
    },
    {
      id: 'lastSeen',
      header: tx.columns.lastSeen,
      width: 'w-[120px]',
      render: (group) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(group.lastSeen, language)}</span>,
    },
    {
      id: 'firstSeen',
      header: tx.columns.firstSeen,
      width: 'hidden md:block md:w-[120px]',
      render: (group) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(group.firstSeen, language)}</span>,
    },
  ];

  if (isLoading && !data && !error) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  const typeLabel = (current?.namePlural ?? type).toLowerCase();

  return (
    <>
      {error && (
        <div className="px-4 pt-4">
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        </div>
      )}
      <PanelEntityList<GroupRow>
        items={groups}
        isLoading={false}
        columns={columns}
        hideFilter
        leftActionButtons={
          <Select value={type} onValueChange={setChosenType}>
            <SelectTrigger size="sm" className="h-8 w-44" aria-label={tx.type}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((g) => (
                <SelectItem key={g.groupType} value={g.groupType}>
                  {g.namePlural}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={tx.search}
        onRowClick={open}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        emptyState={{ icon: <Building2 className="size-8 text-muted-foreground" />, title: format(tx.emptyTitle, { type: typeLabel }), description: tx.emptyDescription }}
        noResultsState={{ icon: <Building2 className="size-8 text-muted-foreground" />, title: tx.noMatches, description: '' }}
      />
    </>
  );
}

export default function GroupsPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const canRead = useCan('panel_people:read');
  return (
    <AnalyticsListPage title={tx.title}>
      {(project) => (canRead ? <GroupsList key={project.id} projectId={project.id} /> : <EmptyState icon={Building2} title={tx.title} description={t.weldpanel.observe.common.noPermission} />)}
    </AnalyticsListPage>
  );
}
