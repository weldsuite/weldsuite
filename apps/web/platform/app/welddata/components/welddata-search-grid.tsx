import { useCallback, useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import { ArrowRightLeft, ListPlus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { LemlistSearchRow, SavedLeadInput } from '@weldsuite/app-api-client/schemas/welddata';
import { EntityGrid, type EntityGridActions } from '@/components/entity-grid';
import { ContextMenuItem } from '@weldsuite/ui/components/context-menu';
import { useObjectPanel } from '@/components/object-panel';
import {
  welddataLeadCacheAtom,
  welddataLeadFromSearchRow,
} from '@/components/objects/welddata-lead';
import {
  useAddLeads,
  useConvertSearchLeads,
  useWelddataLists,
} from '@/hooks/queries/use-welddata-queries';
import { AddToCrmListDialog } from './add-to-crm-list-dialog';
import {
  buildLeadColumns,
  buildLeadGridConfig,
  leadColumnOptionsForKind,
} from '../config/lead-grid-config';

interface WelddataSearchGridProps {
  rows: LemlistSearchRow[];
  kind: 'person' | 'company';
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  /** Server-search bar (keyword + Search + count) rendered inside the toolbar. */
  toolbarActions?: React.ReactNode;
}

function toSavedLead(row: LemlistSearchRow): SavedLeadInput {
  return {
    kind: row.kind,
    lemlistId: row.id,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    title: row.title ?? undefined,
    companyName: row.companyName ?? undefined,
    domain: row.domain ?? undefined,
    industry: row.industry ?? undefined,
    location: row.location ?? undefined,
    country: row.country ?? undefined,
    companySize: row.companySize ?? undefined,
    linkedinUrl: row.linkedinUrl ?? undefined,
    data: row.raw,
  };
}

/**
 * Search results rendered through the shared EntityGrid (same component as
 * /weldcrm/people). Row selection + the grid's built-in "Add to list" picker
 * replace the old bespoke table and dialog; lists come from the workspace's
 * WeldData lists (created from the sidebar).
 */
export function WelddataSearchGrid({
  rows,
  kind,
  onLoadMore,
  hasMore,
  isFetchingMore,
  toolbarActions,
}: WelddataSearchGridProps) {
  const t = useTranslations();
  const addLeads = useAddLeads();
  const convertSearch = useConvertSearchLeads();
  const { data: listsResp } = useWelddataLists();
  const { open: openObjectPanel } = useObjectPanel();
  const cacheLead = useSetAtom(welddataLeadCacheAtom);

  // "Add to CRM list" dialog state. Rows are stashed when the action fires;
  // the grid selection is cleared after a successful add.
  const [crmListOpen, setCrmListOpen] = useState(false);
  const [crmListLeads, setCrmListLeads] = useState<SavedLeadInput[]>([]);
  const clearSelectionRef = useRef<(() => void) | null>(null);

  const openAddToCrmList = useCallback(
    (rowsToAdd: LemlistSearchRow[], clearSelection?: () => void) => {
      if (rowsToAdd.length === 0) return;
      setCrmListLeads(rowsToAdd.map(toSavedLead));
      clearSelectionRef.current = clearSelection ?? null;
      setCrmListOpen(true);
    },
    [],
  );

  // Convert search rows straight into CRM people/companies (no list needed).
  const convertRows = useCallback(
    async (rowsToConvert: LemlistSearchRow[]) => {
      const leads = rowsToConvert.map(toSavedLead);
      if (leads.length === 0) return;
      try {
        const res = await convertSearch.mutateAsync({ leads, createCompany: true });
        toast.success(
          res.converted === 1
            ? t('welddata.toasts.converted')
            : t('welddata.toasts.convertedMany', { count: res.converted }),
        );
      } catch {
        toast.error(t('welddata.toasts.convertFailed'));
      }
    },
    [convertSearch, t],
  );

  const config = useMemo(() => {
    // Company searches get company columns; person searches get person columns.
    // Email is excluded — the database search never returns it.
    const columns = buildLeadColumns<LemlistSearchRow>(leadColumnOptionsForKind(kind));
    return {
      ...buildLeadGridConfig(columns),
      // Right-click a single row → convert to CRM, or add it to a CRM list.
      renderRowContextMenu: (row: LemlistSearchRow) => (
        <>
          <ContextMenuItem onSelect={() => convertRows([row])}>
            {t('welddata.detail.convert')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openAddToCrmList([row])}>
            {t('welddata.crmList.add')}
          </ContextMenuItem>
        </>
      ),
    };
  }, [kind, convertRows, openAddToCrmList, t]);

  // Only lists of the same kind as the current search can receive these rows —
  // a list never mixes people and companies.
  const availableLists = useMemo(
    () =>
      (listsResp?.data ?? [])
        .filter((l) => l.kind === kind)
        .map((l) => ({
          id: l.id,
          title: l.name,
          color: l.color || 'bg-blue-500',
        })),
    [listsResp, kind],
  );

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const actions: EntityGridActions<LemlistSearchRow> = useMemo(
    () => ({
      // Clicking a row opens a read-only object panel for that lead. Search
      // rows aren't persisted, so stash the clicked row in the panel cache
      // first, then open the panel by its id.
      onRowClick: (row) => {
        cacheLead((prev) => ({ ...prev, [row.id]: welddataLeadFromSearchRow(row) }));
        openObjectPanel({ type: 'welddata-lead', id: row.id });
      },
      // Search results are read-only; updates/deletes are not offered.
      onUpdateEntity: async () => ({ success: false }),
      onDeleteEntity: async () => ({ success: true }),
      onAddToList: async (ids, listId) => {
        const leads = ids
          .map((id) => rowById.get(id))
          .filter((r): r is LemlistSearchRow => Boolean(r))
          .map(toSavedLead);
        if (leads.length === 0) return;
        try {
          const res = await addLeads.mutateAsync({ listId, input: { leads } });
          toast.success(t('welddata.toasts.leadsAdded', { count: res.added }));
          if (res.skipped > 0) {
            toast.info(t('welddata.toasts.leadsSkipped', { count: res.skipped }));
          }
        } catch {
          toast.error(t('welddata.toasts.searchFailed'));
        }
      },
      // Selection-bar actions: convert the checked rows to CRM, or add them
      // straight to a CRM list (the dialog clears the selection on success).
      bulkActions: [
        {
          id: 'convert-to-crm',
          label: t('welddata.detail.moveToCrm'),
          icon: ArrowRightLeft,
          onAction: async (ids, clearSelection) => {
            const rowsToConvert = ids
              .map((id) => rowById.get(id))
              .filter((r): r is LemlistSearchRow => Boolean(r));
            await convertRows(rowsToConvert);
            clearSelection();
          },
        },
        {
          id: 'add-to-crm-list',
          label: t('welddata.crmList.add'),
          icon: ListPlus,
          onAction: (ids, clearSelection) => {
            const rowsToAdd = ids
              .map((id) => rowById.get(id))
              .filter((r): r is LemlistSearchRow => Boolean(r));
            openAddToCrmList(rowsToAdd, clearSelection);
          },
        },
      ],
    }),
    [addLeads, rowById, t, cacheLead, openObjectPanel, convertRows, openAddToCrmList],
  );

  return (
    <>
      <EntityGrid
        // Remount on kind change so person/company column sets never bleed
        // together via EntityGrid's column-sync merge.
        key={kind}
        config={config}
        actions={actions}
        entities={rows}
        pagination={{ page: 1, pageSize: rows.length || 25, totalCount: rows.length, totalPages: 1, hasMore }}
        availableLists={availableLists}
        // Show only the Sort + View settings (show/hide columns) controls. Search
        // is owned by the page's server-side keyword bar, and there are no
        // create/import/export actions, so the toolbar reduces to those two.
        hideToolbarSearch
        hideToolbarFilter
        toolbarActions={toolbarActions}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
      />

      <AddToCrmListDialog
        open={crmListOpen}
        onOpenChange={setCrmListOpen}
        kind={kind}
        leads={crmListLeads}
        onAdded={() => clearSelectionRef.current?.()}
      />
    </>
  );
}
