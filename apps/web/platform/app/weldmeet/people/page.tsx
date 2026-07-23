import { useCallback, useMemo } from 'react';
import { PageLoader } from '@/components/page-loader';
import {
  EntityGrid,
  type EntityGridActions,
  type GridPaginationState,
} from '@/components/entity-grid';
import { useInfinitePeople, type Person } from '@/hooks/queries/use-people-queries';
import {
  personGridConfig,
  personColumns,
} from '@/app/weldcrm/people/config/person-grid-config';
import {
  useObjectPanel,
  useObjectPanelUrlSync,
} from '@/components/object-panel';

const pageSize = 50;

export default function MeetPeoplePage() {
  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfinitePeople({ limit: pageSize });

  const people = useMemo(
    () => infiniteData?.pages.flatMap((page) => page.data ?? []) ?? [],
    [infiniteData],
  );

  const totalCount = infiniteData?.pages[0]?.pagination?.totalCount ?? 0;

  useObjectPanelUrlSync('/weldmeet/people');
  const { open: openObjectPanel } = useObjectPanel();

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const gridConfig = useMemo(
    () => ({
      ...personGridConfig,
      gridViewName: 'weldmeet-person',
      columns: personColumns,
      allowCustomColumns: false,
      enableInlineEditing: false,
      enableExport: false,
      enableImport: false,
    }),
    [],
  );

  const actions: EntityGridActions<Person> = useMemo(
    () => ({
      onUpdateEntity: async () => ({ success: true }),
      onDeleteEntity: async () => ({ success: true }),
      onRowClick: (person) => {
        openObjectPanel({ type: 'person', id: person.id });
      },
    }),
    [openObjectPanel],
  );

  const pagination: GridPaginationState = {
    page: 1,
    pageSize,
    totalCount,
    totalPages: 1,
    hasMore: !!hasNextPage,
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="h-[calc(100vh-4rem)]">
      <EntityGrid
        config={gridConfig}
        actions={actions}
        entities={people}
        pagination={pagination}
        onLoadMore={handleLoadMore}
        hasMore={!!hasNextPage}
        isFetchingMore={isFetchingNextPage}
      />
    </div>
  );
}
