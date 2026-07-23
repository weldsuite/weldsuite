/**
 * Unified CRM list detail page — `/weldcrm/lists/:listId`.
 *
 * Loads the list, branches on `list.kind`, and renders either the
 * CompaniesGrid or the PeopleGrid filtered to that list's members. The
 * AddMemberPicker above the grid is kind-aware. Row delete is rewired via
 * `listContext` to remove from the list (not delete the underlying
 * company/person).
 */

import { Suspense, useCallback, useMemo } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@weldsuite/i18n/client';
import { useList, useRemoveListMember, listKeys } from '@/hooks/queries/use-lists-queries';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ArrowLeft } from 'lucide-react';
import { CompaniesGrid } from '@/app/weldcrm/companies/components/companies-grid';
import { PeopleGrid } from '@/app/weldcrm/people/components/people-grid';
import {
  useInfiniteCompanies,
  companyKeys,
  type Company,
} from '@/hooks/queries/use-companies-queries';
import {
  useInfinitePeople,
  personKeys,
  type Person,
} from '@/hooks/queries/use-people-queries';
import { AddMemberPicker } from './add-member-picker';

function CompanyListView({ listId, listName }: { listId: string; listName: string }) {
  const t = useTranslations();
  const qc = useQueryClient();
  const removeMember = useRemoveListMember();
  const filters = useMemo(() => ({ listId, limit: 50 }), [listId]);
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteCompanies(filters);

  const rows = useMemo<Company[]>(
    () => data?.pages.flatMap((p) => p.data ?? []) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.pagination?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const removeFromList = useCallback(
    async (entityId: string) => {
      await removeMember.mutateAsync({ listId, entityId });
      // Drop the row from the grid + refresh count badges elsewhere.
      qc.invalidateQueries({ queryKey: companyKeys.lists() });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    [removeMember, qc, listId],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <CompaniesGrid
      companies={rows}
      totalCount={totalCount}
      searchParams={{}}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
      toolbarActions={<AddMemberPicker listId={listId} kind="company" />}
      listContext={{
        listId,
        removeMember: removeFromList,
        removeFailedMessage: t('crm.listPage.removeFromListFailed', { listName }),
      }}
    />
  );
}

function PersonListView({ listId, listName }: { listId: string; listName: string }) {
  const t = useTranslations();
  const qc = useQueryClient();
  const removeMember = useRemoveListMember();
  const filters = useMemo(() => ({ listId, limit: 50 }), [listId]);
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfinitePeople(filters);

  const rows = useMemo<Person[]>(
    () => data?.pages.flatMap((p) => p.data ?? []) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.pagination?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const removeFromList = useCallback(
    async (entityId: string) => {
      await removeMember.mutateAsync({ listId, entityId });
      qc.invalidateQueries({ queryKey: personKeys.lists() });
      qc.invalidateQueries({ queryKey: listKeys.members(listId) });
      qc.invalidateQueries({ queryKey: listKeys.all });
    },
    [removeMember, qc, listId],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <PeopleGrid
      people={rows}
      totalCount={totalCount}
      searchParams={{}}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
      toolbarActions={<AddMemberPicker listId={listId} kind="person" />}
      listContext={{
        listId,
        removeMember: removeFromList,
        removeFailedMessage: t('crm.listPage.removeFromListFailed', { listName }),
      }}
    />
  );
}

export default function ListPage() {
  const { listId } = useParams<{ listId: string }>();
  const router = useRouter();
  const t = useTranslations();
  const { data: listResp, isLoading } = useList(listId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const list = listResp?.data;
  if (!list) {
    return (
      <Card className="m-6">
        <CardContent className="py-12 text-center space-y-3">
          <h1 className="text-lg font-semibold">{t('crm.listPage.notFound')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('crm.listPage.notFoundDescription')}
          </p>
          <Button variant="outline" onClick={() => router.push('/weldcrm')}>
            <ArrowLeft className="h-4 w-4 mr-2" /> {t('crm.listPage.backToWeldCRM')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex-1 min-h-0">
        <Suspense fallback={<PageLoader fullScreen={false} />}>
          {list.kind === 'company' ? (
            <CompanyListView listId={list.id} listName={list.name} />
          ) : (
            <PersonListView listId={list.id} listName={list.name} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
