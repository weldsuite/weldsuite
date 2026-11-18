/** Groups: the companies (or other group types) the project's events belong to, per type, searchable, each row opening a profile. */

import { useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelGroupDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useWeldPanelGroupTypes, useWeldPanelGroups } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { QueryErrorState } from '../components/query-error-state';
import { formatDate } from '../lib/format';
import { groupHref } from './links';

const SEARCH_DEBOUNCE_MS = 300;

function GroupRow({ group, projectId, onOpen }: Readonly<{ group: PanelGroupDto; projectId: string; onOpen: (group: PanelGroupDto) => void }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const name = group.name?.trim() || group.groupKey;
  return (
    <TableRow className="cursor-pointer" onClick={() => onOpen(group)}>
      <TableCell className="max-w-64 font-medium">
        <Link
          href={groupHref(group.groupType, group.groupKey, projectId)}
          className="block truncate hover:underline"
          aria-label={format(tx.open, { name })}
          onClick={(event) => event.stopPropagation()}
        >
          {name}
        </Link>
      </TableCell>
      <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">{group.groupKey}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(group.lastSeen, language)}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">{formatDate(group.firstSeen, language)}</TableCell>
    </TableRow>
  );
}

function GroupsList({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const router = useRouter();
  const params = useSearchParams();
  const { data: types, isLoading: typesLoading, isError: typesError, refetch: refetchTypes } = useWeldPanelGroupTypes(projectId);
  const [chosenType, setChosenType] = useState(params.get('type') ?? '');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const type = types?.some((g) => g.groupType === chosenType) ? chosenType : (types?.[0]?.groupType ?? '');
  const listParams = useMemo(() => ({ projectId, type, search: debounced || undefined, limit: 50 }), [projectId, type, debounced]);
  const { data, error, isLoading, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useWeldPanelGroups(listParams, type !== '');
  const groups = data?.groups ?? [];
  const current = types?.find((g) => g.groupType === type);

  if (typesLoading) return <Skeleton className="h-40 w-full" />;
  if (typesError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetchTypes()} retryLabel={t.weldpanel.retry} />;
  if (!types || types.length === 0) return <EmptyState icon={Building2} title={tx.noTypesTitle} description={tx.noTypesDescription} />;

  const open = (group: PanelGroupDto) => router.push(groupHref(group.groupType, group.groupKey, projectId));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={type} onValueChange={setChosenType}>
          <TabsList aria-label={tx.type}>
            {types.map((g) => (
              <TabsTrigger key={g.groupType} value={g.groupType}>
                {g.namePlural}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <SearchInput className="w-full sm:w-72" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tx.search} aria-label={tx.search} />
      </div>

      {error && <QueryErrorState error={error} onRetry={() => void refetch()} />}
      {!error && isLoading && (
        <div className="grid gap-2" role="status" aria-label={t.common.labels.loading}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {!error && !isLoading && groups.length === 0 && (
        <EmptyState
          icon={Building2}
          title={debounced ? tx.noMatches : format(tx.emptyTitle, { type: (current?.namePlural ?? type).toLowerCase() })}
          description={debounced ? undefined : tx.emptyDescription}
        />
      )}
      {!error && !isLoading && groups.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx.columns.name}</TableHead>
                  <TableHead>{tx.columns.key}</TableHead>
                  <TableHead>{tx.columns.lastSeen}</TableHead>
                  <TableHead className="hidden md:table-cell">{tx.columns.firstSeen}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <GroupRow key={`${group.groupType}:${group.groupKey}`} group={group} projectId={projectId} onOpen={open} />
                ))}
              </TableBody>
            </Table>
          </div>
          {hasNextPage && (
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {isFetchingNextPage ? t.weldpanel.observe.common.loadingMore : tx.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function GroupsPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.groups;
  const canRead = useCan('panel_people:read');
  return (
    <AnalyticsPage title={tx.title} description={tx.description}>
      {(project) => (canRead ? <GroupsList key={project.id} projectId={project.id} /> : <EmptyState icon={Building2} title={tx.title} description={t.weldpanel.observe.common.noPermission} />)}
    </AnalyticsPage>
  );
}
