
import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@weldsuite/i18n/client';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  EntityGrid,
  type EntityGridActions,
  type GridPaginationState,
} from '@/components/entity-grid';
import { personGridConfig, personColumns } from '../config/person-grid-config';
import {
  useUpdatePerson,
  useDeletePerson,
  useExportPeople,
  useImportPeople,
  type Person,
  type ImportPersonRecord,
  type ExportPeopleQuery,
} from '@/hooks/queries/use-people-queries';
import { useCustomFields } from '@/hooks/use-custom-fields';
import { customFieldsToGridColumns } from '@/components/custom-fields/to-grid-columns';
import { customFieldsToImportFields } from '@/components/custom-fields/to-import-fields';
import { useGridViewSettings } from '@/hooks/queries/use-settings-queries';
import { exportToCSV, exportToExcel } from '@/components/entity-grid/utils/export-utils';
import { QuickAddPersonDialog } from './quick-add-person-dialog';
import { ImportEntitiesDialog } from '@/app/weldcrm/components/import-entities-dialog';
import {
  getPersonImportFields,
  PERSON_IMPORT_REQUIRE_ONE_OF,
  PERSON_IMPORT_TEMPLATE_EXAMPLE,
} from '../config/person-import-fields';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { EntityGridSkeleton } from '@/components/entity-grid/components/grid-skeleton';

interface PeopleGridProps {
  people: Person[];
  totalCount: number;
  searchParams?: { search?: string; status?: string; filter?: string; companyId?: string; sort?: string; sortDir?: string };
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  /**
   * When rendering as the member view of a kind='person' list, this swaps
   * the row delete action from "delete the person" to "remove from this
   * list". The destructive global delete is intentionally unreachable in
   * this context — list views must not delete identity rows.
   */
  listContext?: {
    listId: string;
    /** Drives the "Remove from list" copy in the bulk-select delete bar. */
    listName?: string;
    removeMember: (entityId: string) => Promise<void>;
    removeFailedMessage?: string;
  };
  /** Extra controls rendered in the grid toolbar, next to Import/Export. */
  toolbarActions?: React.ReactNode;
}

/** Run `action` for every id sequentially and count how many succeeded / failed. */
async function countOutcomes(
  ids: string[],
  action: (id: string) => Promise<unknown>,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await action(id);
      ok++;
    } catch {
      fail++;
    }
  }
  return { ok, fail };
}

export function PeopleGrid({
  people,
  totalCount,
  searchParams,
  onLoadMore,
  hasMore,
  isFetchingMore,
  listContext,
  toolbarActions,
}: Readonly<PeopleGridProps>) {
  const t = useTranslations();
  const updateMut = useUpdatePerson();
  const deleteMut = useDeletePerson();
  const exportMut = useExportPeople();
  const importMut = useImportPeople();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcrm/people');

  // Shares its cache with the grid's Owner-column member picker (same
  // queryKey) — resolves the Owner column's userId to a name for CSV/Excel
  // export instead of writing the raw id.
  const { getClient } = useAppApiClient();
  const { data: teamMembersData } = useQuery({
    queryKey: ['team-members', 'list'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: Array<{ userId: string; name: string | null; email?: string | null }> }>(
        '/team-members',
      );
    },
  });
  const memberNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of teamMembersData?.data ?? []) {
      map[m.userId] = m.name?.trim() || m.email || m.userId;
    }
    return map;
  }, [teamMembersData]);

  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: customFieldDefs } = useCustomFields('person');
  const customColumns = useMemo(
    () =>
      customFieldsToGridColumns<Person>(customFieldDefs, {
        getCustomFields: (p) => p.customFields as Record<string, unknown> | null | undefined,
      }),
    [customFieldDefs],
  );

  // Built-in importable fields + any user-defined custom fields.
  const importFields = useMemo(
    () => [...getPersonImportFields(t), ...customFieldsToImportFields(customFieldDefs)],
    [t, customFieldDefs],
  );

  // `isPending` rather than `isLoading`: while the persisted query cache is
  // still restoring after a reload the query is idle (`isLoading` false) with
  // no data yet, and a grid mounted then starts on the default columns.
  const { data: savedView, isPending: isViewLoading } = useGridViewSettings('person');

  // Tags are free-form; suggest the ones other loaded people already use.
  // Keyed on the joined list so the columns are only rebuilt when the set of
  // tags changes, not on every row update.
  const tagOptionsKey = useMemo(
    () => JSON.stringify([...new Set(people.flatMap((p) => p.tags ?? []))].sort((a, b) => a.localeCompare(b))),
    [people],
  );
  const personColumnsWithTags = useMemo(() => {
    const tagOptions = JSON.parse(tagOptionsKey) as string[];
    return personColumns.map((column) => (column.id === 'tags' ? { ...column, options: tagOptions } : column));
  }, [tagOptionsKey]);

  const gridConfig = useMemo(() => ({
    ...personGridConfig,
    columns: [...personColumnsWithTags, ...customColumns],
    initialVisibility: savedView?.columnVisibility ?? null,
    initialColumnWidths: savedView?.columnWidths ?? null,
  }), [personColumnsWithTags, customColumns, savedView]);

  // Export honors the active view (search/status/supplier/lead/company + list).
  const exportFilter = useMemo<ExportPeopleQuery>(() => {
    const f: ExportPeopleQuery = {};
    if (searchParams?.search) f.search = searchParams.search;
    if (searchParams?.status) f.status = searchParams.status;
    if (searchParams?.companyId) f.companyId = searchParams.companyId;
    if (searchParams?.filter === 'suppliers') f.isSupplier = true;
    else if (searchParams?.filter === 'leads') f.isLead = true;
    if (listContext?.listId) f.listId = listContext.listId;
    return f;
  }, [searchParams, listContext]);

  const handleExport = useCallback(
    async (format: 'csv' | 'xlsx') => {
      try {
        const rows = await exportMut.mutateAsync(exportFilter);
        if (rows.length === 0) {
          toast.error(t('crm.importExport.exportEmpty'));
          return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const columns = [...personColumns, ...customColumns];
        const exportContext = { memberNameById };
        if (format === 'csv') await exportToCSV(rows, columns, `people-${stamp}.csv`, exportContext);
        else await exportToExcel(rows, columns, `people-${stamp}.xlsx`, 'People', exportContext);
        toast.success(
          t('crm.importExport.exportSuccess', {
            n: rows.length,
            entity: t('crm.importExport.entityPeople'),
          }),
        );
      } catch (err) {
        console.error('[PeopleGrid] export failed:', err);
        toast.error(t('crm.importExport.exportFailed'));
      }
    },
    [exportMut, exportFilter, customColumns, memberNameById, t],
  );

  const actions: EntityGridActions<Person> = useMemo(() => ({
    onUpdateEntity: async (id, updates) => {
      try {
        await updateMut.mutateAsync({ id, data: updates as Parameters<typeof updateMut.mutateAsync>[0]['data'] });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : t('crm.peopleGrid.updateFailed') };
      }
    },
    onDeleteEntity: async (id) => {
      if (listContext) {
        try {
          await listContext.removeMember(id);
          return { success: true };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : (listContext.removeFailedMessage ?? 'Failed to remove from list'),
          };
        }
      }
      try {
        await deleteMut.mutateAsync(id);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : t('crm.peopleGrid.deleteFailed') };
      }
    },
    onBulkDelete: async (ids) => {
      if (listContext) {
        const { ok, fail } = await countOutcomes(ids, listContext.removeMember);
        if (fail === 0) toast.success(t('crm.peopleGrid.removeFromListSuccess', { count: ok }));
        else toast.error(t('crm.peopleGrid.removeFromListPartial', { succeeded: ok, failed: fail }));
        return;
      }
      const { ok, fail } = await countOutcomes(ids, deleteMut.mutateAsync);
      if (fail === 0) toast.success(ok === 1 ? t('crm.peopleGrid.bulkDeleteSuccess', { count: ok }) : t('crm.peopleGrid.bulkDeleteSuccessPlural', { count: ok }));
      else toast.error(t('crm.peopleGrid.bulkDeletePartial', { succeeded: ok, failed: fail }));
    },
    onRowClick: (person) => {
      openObjectPanel({ type: 'person', id: person.id });
    },
    // In a list context the page's "Add person" picker is the single entry
    // point (it can both add existing people and create new ones inline),
    // so the grid's own "New person" button is suppressed.
    onCreateEntity: listContext ? undefined : () => setIsQuickAddOpen(true),
    onImport: () => setIsImportOpen(true),
    onExportCSV: () => handleExport('csv'),
    onExportExcel: () => handleExport('xlsx'),
  }), [updateMut, deleteMut, openObjectPanel, t, listContext, handleExport]);

  const pagination: GridPaginationState = {
    page: 1,
    pageSize: 50,
    totalCount,
    totalPages: 1,
    hasMore,
  };

  return (
    <>
      {isViewLoading ? (
        <EntityGridSkeleton />
      ) : (
        <EntityGrid
          config={gridConfig}
          actions={actions}
          entities={people}
          pagination={pagination}
          searchParams={searchParams}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isFetchingMore={isFetchingMore}
          toolbarActions={toolbarActions}
          listName={listContext?.listName}
          persistSort={!listContext}
        />
      )}
      <QuickAddPersonDialog open={isQuickAddOpen} onOpenChange={setIsQuickAddOpen} />
      <ImportEntitiesDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        entityLabel={t('crm.importExport.entityPeople')}
        fields={importFields}
        requireOneOf={PERSON_IMPORT_REQUIRE_ONE_OF}
        templateExample={PERSON_IMPORT_TEMPLATE_EXAMPLE}
        templateName="people"
        onImportBatch={(records) => importMut.mutateAsync(records as ImportPersonRecord[])}
      />
    </>
  );
}
