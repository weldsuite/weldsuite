
import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import {
  EntityGrid,
  type EntityGridActions,
  type GridPaginationState,
} from '@/components/entity-grid';
import {
  companyGridConfig,
  companyColumns,
} from '../config/company-grid-config';
import {
  useUpdateCompany,
  useDeleteCompany,
  useExportCompanies,
  useImportCompanies,
  type Company,
  type ImportCompanyRecord,
  type ExportCompaniesQuery,
} from '@/hooks/queries/use-companies-queries';
import { useCustomFields } from '@/hooks/use-custom-fields';
import { customFieldsToGridColumns } from '@/components/custom-fields/to-grid-columns';
import { customFieldsToImportFields } from '@/components/custom-fields/to-import-fields';
import { useGridViewSettings } from '@/hooks/queries/use-settings-queries';
import { exportToCSV, exportToExcel } from '@/components/entity-grid/utils/export-utils';
import { QuickAddCompanyDialog } from './quick-add-company-dialog';
import { ImportEntitiesDialog } from '@/app/weldcrm/components/import-entities-dialog';
import {
  getCompanyImportFields,
  COMPANY_IMPORT_REQUIRE_ONE_OF,
  COMPANY_IMPORT_TEMPLATE_EXAMPLE,
} from '../config/company-import-fields';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';

interface CompaniesGridProps {
  companies: Company[];
  totalCount: number;
  searchParams?: { search?: string; status?: string; filter?: string };
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  /**
   * When rendering as the member view of a kind='company' list, this swaps
   * the row delete action from "delete the company" to "remove from this
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

export function CompaniesGrid({
  companies,
  totalCount,
  searchParams,
  onLoadMore,
  hasMore,
  isFetchingMore,
  listContext,
  toolbarActions,
}: CompaniesGridProps) {
  const t = useTranslations();
  const router = useRouter();
  const updateMut = useUpdateCompany();
  const deleteMut = useDeleteCompany();
  const exportMut = useExportCompanies();
  const importMut = useImportCompanies();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcrm/companies');

  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const { data: customFieldDefs } = useCustomFields('company');
  const customColumns = useMemo(
    () =>
      customFieldsToGridColumns<Company>(customFieldDefs, {
        getCustomFields: (c) => c.customFields as Record<string, unknown> | null | undefined,
      }),
    [customFieldDefs],
  );

  // Built-in importable fields + any user-defined custom fields.
  const importFields = useMemo(
    () => [...getCompanyImportFields(t), ...customFieldsToImportFields(customFieldDefs)],
    [t, customFieldDefs],
  );

  // Saved column visibility/widths per user (persisted by EntityGrid on change).
  const { data: savedView, isLoading: isViewLoading } = useGridViewSettings('company');

  const gridConfig = useMemo(() => ({
    ...companyGridConfig,
    columns: [...companyColumns, ...customColumns],
    initialVisibility: savedView?.columnVisibility ?? null,
    initialColumnWidths: savedView?.columnWidths ?? null,
  }), [customColumns, savedView]);

  // Export honors the active view (search/status/supplier/lead + list scope).
  const exportFilter = useMemo<ExportCompaniesQuery>(() => {
    const f: ExportCompaniesQuery = {};
    if (searchParams?.search) f.search = searchParams.search;
    if (searchParams?.status) f.status = searchParams.status;
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
        const columns = [...companyColumns, ...customColumns];
        if (format === 'csv') await exportToCSV(rows, columns, `companies-${stamp}.csv`);
        else await exportToExcel(rows, columns, `companies-${stamp}.xlsx`, 'Companies');
        toast.success(
          t('crm.importExport.exportSuccess', {
            n: rows.length,
            entity: t('crm.importExport.entityCompanies'),
          }),
        );
      } catch (err) {
        console.error('[CompaniesGrid] export failed:', err);
        toast.error(t('crm.importExport.exportFailed'));
      }
    },
    [exportMut, exportFilter, customColumns, t],
  );

  const actions: EntityGridActions<Company> = useMemo(() => ({
    onUpdateEntity: async (id, updates) => {
      try {
        await updateMut.mutateAsync({ id, data: updates as Parameters<typeof updateMut.mutateAsync>[0]['data'] });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : t('crm.companiesGrid.updateFailed') };
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
        return { success: false, error: err instanceof Error ? err.message : t('crm.companiesGrid.deleteFailed') };
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
        if (fail === 0) toast.success(t('crm.companiesGrid.removeFromListSuccess', { count: ok }));
        else toast.error(t('crm.companiesGrid.removeFromListPartial', { succeeded: ok, failed: fail }));
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
      if (fail === 0) toast.success(ok === 1 ? t('crm.companiesGrid.bulkDeleteSuccess', { count: ok }) : t('crm.companiesGrid.bulkDeleteSuccessPlural', { count: ok }));
      else toast.error(t('crm.companiesGrid.bulkDeletePartial', { succeeded: ok, failed: fail }));
    },
    onRowClick: (company) => {
      // Open in object panel (URL syncs via useObjectPanelUrlSync above).
      openObjectPanel({ type: 'company', id: company.id });
    },
    // In a list context the page's "Add company" picker is the single entry
    // point (it can both add existing companies and create new ones inline),
    // so the grid's own "New company" button is suppressed.
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
          entities={companies}
          pagination={pagination}
          searchParams={searchParams}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isFetchingMore={isFetchingMore}
          toolbarActions={toolbarActions}
        />
      )}
      <QuickAddCompanyDialog open={isQuickAddOpen} onOpenChange={setIsQuickAddOpen} />
      <ImportEntitiesDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        entityLabel={t('crm.importExport.entityCompanies')}
        fields={importFields}
        requireOneOf={COMPANY_IMPORT_REQUIRE_ONE_OF}
        templateExample={COMPANY_IMPORT_TEMPLATE_EXAMPLE}
        templateName="companies"
        onImportBatch={(records) => importMut.mutateAsync(records as ImportCompanyRecord[])}
      />
    </>
  );
}
