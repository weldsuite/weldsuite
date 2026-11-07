/**
 * The decision log as the standard list: the column header and task-style
 * rows, built from the shared WeldFlow list cells like the RAID registers. The
 * search and filters are the toolbar's, so the list's own bar is hidden; a row
 * opens the decision's object panel.
 */

import { useState, type ReactNode } from 'react';
import { Gavel, Pencil, Replace, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { Decision } from '@weldsuite/app-api-client/domains/project-governance';
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
import { EntityList, type ActiveFilter, type HeaderColumn } from '@/components/entity-list';
import { useObjectPanelNavigationReporter } from '@/components/object-panel';
import { useDeleteDecision } from '@/hooks/queries/use-project-governance-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useToday } from '../../../raid/_components/raid-context';
import { isOverdue } from '../../../raid/_lib/risk';
import { useFormatters, type GovernanceAbilities, type GovernanceMember } from '../../_lib/use-governance';
import { deciderOf } from '../_lib/decision-filters';
import { DECISION_PANEL_TYPE } from './decision-panel-type';
import type { DecisionDialogState } from './decision-dialogs';
import { DecisionsIllustration } from './decision-illustrations';
import { DecisionStatusPill, useMemberName } from './decision-parts';

/**
 * One column of the log. `width` carries the column's size and, for the
 * columns that give way on a narrow list (the panel open, a phone), a
 * container breakpoint such as `hidden @3xl:flex`: the header and the rows
 * share it, so they stay aligned.
 */
interface DecisionColumn {
  id: string;
  header: string;
  width: string;
  render: (decision: Decision) => ReactNode;
}

interface RowMenuProps {
  decision: Decision;
  abilities: GovernanceAbilities;
  onDialog: (state: DecisionDialogState) => void;
  onDelete: (decision: Decision) => void;
}

/** Edit, record, replace and delete: what the member may do with this decision. */
function RowMenu({ decision, abilities, onDialog, onDelete }: Readonly<RowMenuProps>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  const canRecord = decision.status === 'proposed' && abilities.update;
  const canReplace = decision.status === 'decided' && abilities.manage;
  if (!abilities.update && !canReplace && !abilities.remove) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ListRowMenuButton label={copy.moreActions} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {abilities.update ? (
          <DropdownMenuItem onSelect={() => onDialog({ kind: 'edit', decision })}>
            <Pencil className="mr-0.5 h-4 w-4" />
            {copy.actions.edit}
          </DropdownMenuItem>
        ) : null}
        {canRecord ? (
          <DropdownMenuItem onSelect={() => onDialog({ kind: 'decide', decision })}>
            <Gavel className="mr-0.5 h-4 w-4" />
            {copy.actions.record}
          </DropdownMenuItem>
        ) : null}
        {canReplace ? (
          <DropdownMenuItem onSelect={() => onDialog({ kind: 'supersede', decision })}>
            <Replace className="mr-0.5 h-4 w-4" />
            {copy.actions.supersede}
          </DropdownMenuItem>
        ) : null}
        {abilities.remove ? (
          <>
            {abilities.update || canReplace ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(decision)}>
              <Trash2 className="mr-0.5 h-4 w-4" />
              {copy.actions.delete}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DecisionListProps {
  /** The decisions to list, already searched and filtered. */
  decisions: Decision[];
  search: string;
  onSearchChange: (search: string) => void;
  filters: ActiveFilter[];
  onFiltersChange: (filters: ActiveFilter[]) => void;
  abilities: GovernanceAbilities;
  memberOf: (userId: string | null | undefined) => GovernanceMember | null;
  /** The decision whose panel is open, highlighted in the list. */
  selectedId: string | null;
  /** Opens a decision's panel; null closes it. */
  onSelect: (id: string | null) => void;
  onDialog: (state: DecisionDialogState) => void;
}

export function DecisionList({
  decisions,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  abilities,
  memberOf,
  selectedId,
  onSelect,
  onDialog,
}: Readonly<DecisionListProps>) {
  const { t, format, plural } = useI18n();
  const copy = t.flowGovernance.decisions;
  const common = t.flowGovernance.common;
  const formatters = useFormatters();
  const now = useToday();
  const memberName = useMemberName(memberOf);
  const deleteDecision = useDeleteDecision();
  const [deleting, setDeleting] = useState<Decision | null>(null);
  // Previous / next in the open decision panel step through the rows as listed.
  const reportDisplayedItems = useObjectPanelNavigationReporter<Decision>({ type: DECISION_PANEL_TYPE });

  const columns: DecisionColumn[] = [
    {
      id: 'title',
      header: copy.columns.decision,
      width: 'min-w-[140px] flex-1',
      render: (decision) => <ListTitle code={decision.code} title={decision.title} />,
    },
    {
      id: 'decider',
      header: copy.columns.decider,
      width: 'hidden w-[150px] @3xl:flex',
      render: (decision) => {
        const id = deciderOf(decision);
        return id ? <ListPerson name={memberName(id)} avatar={memberOf(id)?.avatar} /> : <ListText text={null} />;
      },
    },
    {
      id: 'date',
      header: copy.columns.date,
      width: 'hidden w-[130px] @4xl:flex',
      render: (decision) => {
        if (decision.status !== 'proposed') return <ListText text={formatters.date(decision.decidedAt ?? decision.createdAt)} />;
        if (!decision.decisionDueAt) return <ListText text={null} />;
        const late = isOverdue(decision.decisionDueAt, now);
        return (
          <span className={cn('block truncate text-sm tabular-nums', late ? 'text-red-700 dark:text-red-400' : 'text-gray-600 dark:text-muted-foreground')}>
            {format(copy.due, { date: formatters.date(decision.decisionDueAt) })}
          </span>
        );
      },
    },
    {
      id: 'options',
      header: copy.columns.options,
      width: 'hidden w-[170px] @5xl:flex',
      render: (decision) => {
        const chosen = decision.options.find((option) => option.chosen);
        if (chosen) return <ListText text={chosen.title} />;
        return <ListText text={decision.options.length > 0 ? plural(decision.options.length, copy.optionsCount) : null} />;
      },
    },
    {
      id: 'status',
      header: copy.columns.status,
      width: 'w-[120px]',
      render: (decision) => <DecisionStatusPill status={decision.status} />,
    },
  ];

  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = columns.map(({ id, header, width }) => ({ id, header, width }));

  const renderRow = (decision: Decision) => {
    const selected = decision.id === selectedId;
    return (
      <div
        key={decision.id}
        aria-current={selected ? 'true' : undefined}
        className={cn(LIST_ROW_CLASS, selected && LIST_ROW_SELECTED_CLASS)}
      >
        <ListRowTarget label={`${decision.code} ${decision.title}`} onClick={() => onSelect(decision.id)} />
        {columns.map((column) => (
          <div key={column.id} className={cn(LIST_CELL_CLASS, column.width)}>
            {column.render(decision)}
          </div>
        ))}
        <div className={LIST_MENU_CELL_CLASS}>
          <RowMenu decision={decision} abilities={abilities} onDialog={onDialog} onDelete={setDeleting} />
        </div>
      </div>
    );
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteDecision.mutateAsync(deleting.id);
      toast.success(copy.toasts.deleted);
      if (deleting.id === selectedId) onSelect(null);
      setDeleting(null);
    } catch {
      toast.error(common.deleteFailed);
    }
  };

  return (
    <section aria-label={copy.listLabel} className="@container">
      <EntityList<Decision>
        items={decisions}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        onDisplayedItemsChange={reportDisplayedItems}
        hideTopBar
        searchQuery={search}
        onSearchChange={onSearchChange}
        activeFilters={filters}
        onFiltersChange={onFiltersChange}
        noResultsState={{ title: copy.noMatch, description: '' }}
        emptyState={{
          icon: <DecisionsIllustration />,
          title: copy.emptyTitle,
          description: abilities.create ? copy.emptyDescription : copy.emptyReadOnly,
          action: abilities.create ? { label: copy.form.createTitle, onClick: () => onDialog({ kind: 'create' }) } : undefined,
        }}
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={deleting ? format(common.deleteConfirmTitle, { code: deleting.code }) : ''}
        description={common.deleteConfirmDescription}
        confirmLabel={common.delete}
        cancelLabel={common.cancel}
        variant="destructive"
        loading={deleteDecision.isPending}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
