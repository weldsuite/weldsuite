/**
 * The change requests as the standard list: the column header and task-style
 * rows from the shared WeldFlow cells. The search and filters are the page
 * toolbar's, so the list's own bar is hidden; a row opens the change's panel,
 * its menu offers edit, submit, withdraw and delete as the member may.
 */

import type { ReactNode } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import type { ChangeRequest } from '@weldsuite/app-api-client/domains/flow-approvals';
import { EntityList, EmptyStateIllustration, type HeaderColumn } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelNavigationReporter } from '@/components/object-panel';
import {
  LIST_CELL_CLASS,
  LIST_MENU_CELL_CLASS,
  LIST_ROW_CLASS,
  LIST_ROW_SELECTED_CLASS,
  ListPerson,
  ListRowMenuButton,
  ListRowTarget,
  ListText,
  ListTitle,
} from '@/app/weldflow/components/list-cells';
import { formatDate, formatMoney } from '@/app/weldflow/_approvals/format';
import { useMemberNames } from '@/app/weldflow/_approvals/use-member-names';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { ChangeMenuItems, hasAnyAction, useChangeActions, type ChangeActions } from './change-actions';
import { changeActions, type ChangeAllowed } from './change-detail';
import type { ChangeFilters } from './change-filters';
import { CHANGE_REQUEST_PANEL_TYPE } from './change-panel-type';
import { ChangeStatusPill, useRouteLabel } from './change-status';
import { useChangeAbilities } from './use-change-abilities';

/**
 * One column of the list. `width` carries the column's size and, for the
 * columns that give way on a narrow list (the panel open, a phone), a
 * container breakpoint such as `hidden @3xl:flex`: the header and the rows
 * share it, so they stay aligned.
 */
interface ChangeListColumn {
  id: string;
  header: string;
  width: string;
  render: (change: ChangeRequest) => ReactNode;
}

/** A sheet with a struck-out line, a new line and an approval stamp, in the drawing style of the tasks page. */
function ChangeRequestsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg
        width="120"
        height="130"
        viewBox="0 0 120 130"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}
      >
        {/* Sheet */}
        <rect x="18" y="14" width="76" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="18" y="14" width="76" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="18" y="14" width="76" height="12" rx="6" className="fill-gray-50/60 dark:fill-white/[0.06]" />
        {/* Title */}
        <rect x="30" y="36" width="34" height="4" rx="2" className="fill-gray-200 dark:fill-white/20" />
        {/* The old line, struck out */}
        <rect x="30" y="52" width="48" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.5" />
        <path d="M28 53.5H80" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1" strokeLinecap="round" />
        {/* The new line */}
        <rect x="30" y="64" width="40" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.7" />
        <rect x="30" y="72" width="26" height="2" rx="1" className="fill-gray-200 dark:fill-white/10" opacity="0.5" />
        {/* Approval stamp */}
        <circle cx="82" cy="98" r="16" className="fill-background stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <path d="M75 98.5L80.5 104L90 92.5" className="stroke-gray-300 dark:stroke-white/25" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </EmptyStateIllustration>
  );
}

interface RowMenuProps {
  change: ChangeRequest;
  /** What the member may do to this change. */
  allowed: ChangeAllowed;
  actions: ChangeActions;
  onEdit: (change: ChangeRequest) => void;
}

/** The three-dot menu of a row; nothing when the member may do nothing to the change. */
function RowMenu({ change, allowed, actions, onEdit }: Readonly<RowMenuProps>) {
  const { t } = useI18n();
  if (!hasAnyAction(allowed)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ListRowMenuButton label={t.flowApprovals.changes.moreActions} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ChangeMenuItems
          allowed={allowed}
          onEdit={() => onEdit(change)}
          onSubmit={() => actions.submit(change)}
          onWithdraw={() => actions.requestWithdraw(change)}
          onDelete={() => actions.requestDelete(change)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ChangeRequestListProps {
  /** The changes to list, already searched and filtered, in display order. */
  changes: ChangeRequest[];
  /** The toolbar's state, so the list can tell "nothing yet" from "nothing matches". */
  filters: ChangeFilters;
  onFiltersChange: (filters: ChangeFilters) => void;
  currency: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (change: ChangeRequest) => void;
  /** Starts a change request; undefined when the member may not (the empty state then has no button). */
  onCreate: (() => void) | undefined;
}

export function ChangeRequestList({ changes, filters, onFiltersChange, currency, selectedId, onSelect, onEdit, onCreate }: Readonly<ChangeRequestListProps>) {
  const { t, language, format } = useI18n();
  const copy = t.flowApprovals.changes;
  const routeLabel = useRouteLabel();
  const { nameOf } = useMemberNames();
  const { closeAll } = useObjectPanel();
  const { abilities, userId } = useChangeAbilities();
  // Previous / next in the open panel step through the rows as listed.
  const reportDisplayedItems = useObjectPanelNavigationReporter<ChangeRequest>({ type: CHANGE_REQUEST_PANEL_TYPE });
  const actions = useChangeActions({ onDeleted: (deleted) => (deleted.id === selectedId ? closeAll() : undefined) });

  const columns: ChangeListColumn[] = [
    {
      id: 'change',
      header: copy.columns.change,
      width: 'min-w-[100px] flex-1',
      render: (change) => <ListTitle code={change.code} title={change.title} />,
    },
    { id: 'status', header: copy.columns.status, width: 'w-[150px]', render: (change) => <ChangeStatusPill status={change.status} /> },
    {
      id: 'cost',
      header: copy.detail.cost,
      width: 'hidden w-[120px] @lg:flex',
      render: (change) => <ListText text={change.costDelta === null ? null : formatMoney(change.costDelta, currency, language)} />,
    },
    {
      id: 'schedule',
      header: copy.detail.schedule,
      width: 'hidden w-[130px] @3xl:flex',
      render: (change) => (
        <ListText text={change.scheduleDeltaDays === null ? null : format(t.flowApprovals.reviews.scheduleDays, { count: String(change.scheduleDeltaDays) })} />
      ),
    },
    {
      id: 'route',
      header: copy.columns.route,
      width: 'hidden w-[150px] @4xl:flex',
      render: (change) => <ListText text={change.route ? routeLabel(change.route) : null} />,
    },
    {
      id: 'updated',
      header: copy.columns.updated,
      width: 'hidden w-[110px] @5xl:flex',
      render: (change) => <ListText text={formatDate(change.updatedAt, language)} />,
    },
    {
      id: 'requestedBy',
      header: copy.columns.requestedBy,
      width: 'hidden w-[130px] @6xl:flex',
      render: (change) => <ListPerson name={change.requestedByName ?? (change.requestedBy ? nameOf(change.requestedBy) : null)} />,
    },
  ];

  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = columns.map(({ id, header, width }) => ({ id, header, width }));

  const renderRow = (change: ChangeRequest) => {
    const selected = change.id === selectedId;
    return (
      <div key={change.id} aria-current={selected ? 'true' : undefined} className={cn(LIST_ROW_CLASS, selected && LIST_ROW_SELECTED_CLASS)}>
        <ListRowTarget label={`${change.code} ${change.title}`} onClick={() => onSelect(change.id)} />
        {columns.map((column) => (
          <div key={column.id} className={cn(LIST_CELL_CLASS, column.width)}>
            {column.render(change)}
          </div>
        ))}
        <div className={LIST_MENU_CELL_CLASS}>
          <RowMenu change={change} allowed={changeActions(change, abilities, userId)} actions={actions} onEdit={onEdit} />
        </div>
      </div>
    );
  };

  return (
    <section aria-label={copy.title} className="@container" data-testid="change-requests">
      <EntityList<ChangeRequest>
        items={changes}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        onDisplayedItemsChange={reportDisplayedItems}
        hideTopBar
        searchQuery={filters.search}
        onSearchChange={(search) => onFiltersChange({ ...filters, search })}
        activeFilters={filters.filters}
        onFiltersChange={(next) => onFiltersChange({ ...filters, filters: next })}
        noResultsState={{ title: copy.emptyFiltered, description: '' }}
        emptyState={{
          icon: <ChangeRequestsIllustration />,
          title: copy.empty,
          description: onCreate ? copy.emptyDescription : copy.emptyReadOnly,
          action: onCreate ? { label: copy.new, onClick: onCreate } : undefined,
        }}
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
      />
      {actions.confirmDialog}
    </section>
  );
}
