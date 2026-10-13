/**
 * WeldReach prospects: the table of everyone who can be emailed, with the
 * saved lists beside it. The top bar carries search, the validation and list
 * filters, Import and "Add prospect"; the breadcrumb is the title.
 *
 * Prospects are B2B only: consumer addresses are skipped unless WeldSuite
 * enabled them for the workspace, and role addresses (info@, sales@, …) are
 * excluded by default. The validation badge says which applies to a row.
 */

import { useMemo, useState } from 'react';
import { UserSearch } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  ReachProspect,
  ReachProspectValidation,
} from '@weldsuite/app-api-client/schemas/reach';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useReachProspectLists,
  useReachProspects,
} from '@/hooks/queries/use-reach-prospect-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { selectFilterConfig, useSelectFilter } from '@/app/weldreach/components/engage/filters';
import { emptyIcon, errorMessage, useReachBreadcrumbs } from '@/app/weldreach/components/engage/kit';
import { ListsPanel } from './components/lists-panel';
import { ProspectDialogs, type ProspectsDialog } from './components/prospect-dialogs';
import { useProspectColumns } from './components/prospect-columns';
import {
  ImportButton,
  MobileFilters,
  SelectAllCheckbox,
  SelectionBar,
  useValidationOptions,
} from './components/prospect-toolbar';
import { useIdSelection } from './lib/use-id-selection';

export default function ReachProspectsPage() {
  const t = useTranslations();
  const format = useReachFormat();
  const { can } = usePermissions();
  useReachBreadcrumbs({ label: t('reachEngage.prospects.title') });

  const [search, setSearch] = useState('');
  const [listId, setListId] = useState<string | undefined>(undefined);
  const validationFilter = useSelectFilter('validation');
  const validation = validationFilter.value as ReachProspectValidation | undefined;
  const [dialog, setDialog] = useState<ProspectsDialog>(null);

  const debouncedSearch = useDebounce(search, 300);
  const query = useReachProspects({ search: debouncedSearch, listId, validation });
  const lists = useReachProspectLists();

  // "is not" has no server counterpart: it hides rows already loaded.
  const prospects = useMemo(
    () => query.prospects.filter((prospect) => prospect.validation !== validationFilter.excluded),
    [query.prospects, validationFilter.excluded],
  );
  const visibleIds = useMemo(() => prospects.map((prospect) => prospect.id), [prospects]);
  const validationOptions = useValidationOptions();
  const selection = useIdSelection(visibleIds);
  const columns = useProspectColumns({ selected: selection.selected, onToggle: selection.toggle });

  const canCreate = can('reach_prospects:create');
  const canUpdate = can('reach_prospects:update');
  const canDelete = can('reach_prospects:delete');
  const listItems = lists.data ?? [];
  const activeList = listItems.find((list) => list.id === listId);
  const isFiltered = Boolean(debouncedSearch.trim() || listId || validation || validationFilter.excluded);

  function selectList(next: string | undefined) {
    setListId(next);
    selection.clear();
  }

  const edit = (prospect: ReachProspect) => setDialog({ kind: 'edit', prospect });
  const emptyState = {
    icon: emptyIcon(UserSearch),
    title: t(isFiltered ? 'reachEngage.prospects.noResultsTitle' : 'reachEngage.prospects.emptyTitle'),
    description: t(
      isFiltered ? 'reachEngage.prospects.noResultsDescription' : 'reachEngage.prospects.emptyDescription',
    ),
    action:
      canCreate && !isFiltered
        ? { label: t('reachEngage.prospects.import'), onClick: () => setDialog({ kind: 'import' }) }
        : undefined,
  };
  const footer = activeList
    ? t('reachEngage.prospects.footerInList', {
        count: format.number(query.totalCount),
        list: activeList.name,
      })
    : t('reachEngage.prospects.footer', { count: format.number(query.totalCount) });

  return (
    <div className="flex h-full min-h-0">
      <ListsPanel
        lists={listItems}
        isLoading={lists.isLoading}
        error={lists.isError ? errorMessage(lists.error, t('reachEngage.prospects.lists.loadFailed')) : null}
        selectedListId={listId}
        canCreate={canCreate}
        canUpdate={canUpdate}
        canDelete={canDelete}
        onSelect={selectList}
        onCreate={() => setDialog({ kind: 'listForm' })}
        onRename={(list) => setDialog({ kind: 'listForm', list })}
        onDelete={(list) => setDialog({ kind: 'deleteList', list })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {selection.selected.size > 0 && (
          <SelectionBar
            count={selection.selected.size}
            canAddToList={canUpdate}
            onAddToList={() => setDialog({ kind: 'addToList' })}
            onClear={selection.clear}
          />
        )}

        <MobileFilters
          lists={listItems}
          listId={listId}
          validation={validation}
          onListChange={selectList}
          onValidationChange={validationFilter.setValue}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <PanelEntityList<ReachProspect>
            items={prospects}
            isLoading={query.isLoading}
            error={query.error}
            columns={columns}
            onRowClick={canUpdate ? edit : undefined}
            onEdit={canUpdate ? edit : undefined}
            onDelete={canDelete ? (prospect) => setDialog({ kind: 'delete', prospect }) : undefined}
            searchFields={['email']}
            searchQuery={search}
            onSearchChange={setSearch}
            searchPlaceholder={t('reachEngage.prospects.searchPlaceholder')}
            filters={[
              selectFilterConfig('validation', t('reachEngage.prospects.table.validation'), validationOptions),
            ]}
            activeFilters={validationFilter.filters}
            onFiltersChange={validationFilter.setFilters}
            leftActionButtons={
              <SelectAllCheckbox
                allSelected={selection.allSelected}
                someSelected={selection.someSelected}
                hasRows={visibleIds.length > 0}
                onToggle={selection.toggleAll}
              />
            }
            actionButtons={canCreate ? <ImportButton onClick={() => setDialog({ kind: 'import' })} /> : undefined}
            createButton={
              canCreate
                ? { label: t('reachEngage.prospects.addProspect'), onClick: () => setDialog({ kind: 'create' }) }
                : undefined
            }
            hasMore={query.hasNextPage}
            isLoadingMore={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
            emptyState={emptyState}
            noResultsState={{
              title: t('reachEngage.prospects.noResultsTitle'),
              description: t('reachEngage.prospects.noResultsDescription'),
            }}
          />
        </div>

        {query.totalCount > 0 && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">{footer}</p>
        )}
      </div>

      <ProspectDialogs
        dialog={dialog}
        listId={listId}
        selectedIds={[...selection.selected]}
        onClose={() => setDialog(null)}
        onShowList={selectList}
        onProspectDeleted={selection.remove}
        onListDeleted={(deletedId) => {
          if (listId === deletedId) selectList(undefined);
        }}
        onAddedToList={selection.clear}
      />
    </div>
  );
}
