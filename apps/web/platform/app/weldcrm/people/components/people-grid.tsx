
import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
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

interface PeopleGridProps {
  people: Person[];
  totalCount: number;
  searchParams?: { search?: string; status?: string; filter?: string; companyId?: string };
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
    removeMember: (entityId: string) => Promise<void>;
    removeFailedMessage?: string;
  };
  /** Extra controls rendered in the grid toolbar, next to Import/Export. */
  toolbarActions?: React.ReactNode;
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
}: PeopleGridProps) {
  const t = useTranslations();
  const updateMut = useUpdatePerson();
  const deleteMut = useDeletePerson();
  const exportMut = useExportPeople();
  const importMut = useImportPeople();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcrm/people');

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

  const { data: savedView, isLoading: isViewLoading } = useGridViewSettings('person');

  const gridConfig = useMemo(() => ({
    ...personGridConfig,
    columns: [...personColumns, ...customColumns],
    initialVisibility: savedView?.columnVisibility ?? null,
    initialColumnWidths: savedView?.columnWidths ?? null,
  }), [customColumns, savedView]);

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
        if (format === 'csv') await exportToCSV(rows, columns, `people-${stamp}.csv`);
        else await exportToExcel(rows, columns, `people-${stamp}.xlsx`, 'People');
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
    [exportMut, exportFilter, customColumns, t],
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
        let ok = 0;
        let fail = 0;
        for (const id of ids) {
          try {
            await listContext.removeMember(id);
            ok++;
          } catch {
            fail++;
          }
        }
        if (fail === 0) toast.success(t('crm.peopleGrid.removeFromListSuccess', { count: ok }));
        else toast.error(t('crm.peopleGrid.removeFromListPartial', { succeeded: ok, failed: fail }));
        return;
      }
      let ok = 0;
      let fail = 0;
      for (const id of ids) {
        try {
          await deleteMut.mutateAsync(id);
          ok++;
        } catch {
          fail++;
        }
      }
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
      {!isViewLoading && (
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
