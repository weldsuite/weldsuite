import { useState, type ReactNode } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { RaidItem, RaidKind, RiskBand } from '@weldsuite/app-api-client/domains/project-control';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { useObjectPanelNavigationReporter } from '@/components/object-panel';
import { useDeleteRaidItem } from '@/hooks/queries/use-project-control-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { bandLabel, statusLabel } from '../_lib/copy';
import { statusTone } from '../_lib/raid';
import { BAND_STYLES, SEVERITY_BAND, TONE_PILL } from '../_lib/styles';
import {
  LIST_CELL_CLASS,
  LIST_MENU_CELL_CLASS,
  LIST_ROW_CLASS,
  LIST_ROW_SELECTED_CLASS,
  ListPill,
  ListPerson,
  ListRowMenuButton,
  ListRowTarget,
  ListText,
  ListTitle,
} from '@/app/weldflow/components/list-cells';
import { DueLabel } from './raid-parts';
import { RAID_ITEM_PANEL_TYPE } from './raid-item-panel-type';
import { useRaid } from './raid-context';

// ── RAID cells, on the shared WeldFlow list cells (sized as a task row's) ───

export { ListPill, ListText };

export function ListStatus({ kind, status }: Readonly<{ kind: RaidKind; status: string }>) {
  const { t } = useI18n();
  return <ListPill className={TONE_PILL[statusTone(kind, status)]}>{statusLabel(t.projects.raid, kind, status)}</ListPill>;
}

/** `20 Critical` on the band colours. */
export function ListScore({ score, band }: Readonly<{ score: number; band: RiskBand }>) {
  const { t } = useI18n();
  return (
    <ListPill className={BAND_STYLES[band].badge}>
      <span className="tabular-nums">{score}</span>
      {bandLabel(t.projects.raid, band)}
    </ListPill>
  );
}

export function ListSeverity({ severity }: Readonly<{ severity: string | null }>) {
  const { t } = useI18n();
  if (!severity) return <ListText text={null} />;
  const band = SEVERITY_BAND[severity];
  const label = (t.projects.raid.severity as unknown as Record<string, string>)[severity] ?? severity;
  return <ListPill className={band ? BAND_STYLES[band].badge : 'bg-muted text-foreground/80'}>{label}</ListPill>;
}

/** A date of a row, as a task's due date: `text-sm`, red when late. */
export function ListDue({ dueAt, closedText }: Readonly<{ dueAt: string | null; closedText?: string | null }>) {
  return <DueLabel dueAt={dueAt} closedText={closedText} className="text-sm font-normal tabular-nums" />;
}

/** The owner of a row, as a task's assignee: a 20px avatar and the first name. */
export function ListOwner({ ownerId }: Readonly<{ ownerId: string | null }>) {
  const { t } = useI18n();
  const { memberOf } = useRaid();
  if (!ownerId) return <ListText text={null} />;
  const member = memberOf(ownerId);
  return <ListPerson name={member?.name ?? t.projects.raid.register.unknownOwner} avatar={member?.avatar} />;
}

/**
 * One column of a register list. `width` carries the column's size and, for
 * the columns that give way on a narrow list (the detail panel open, a phone),
 * a container breakpoint such as `hidden @3xl:flex`: the header and the rows
 * share it, so they stay aligned.
 */
export interface RaidListColumn {
  id: string;
  header: string;
  width: string;
  render: (item: RaidItem) => ReactNode;
}

/** The first column of every register: the item code and its title on one line. */
export function titleColumn(header: string): RaidListColumn {
  return {
    id: 'title',
    header,
    width: 'min-w-[140px] flex-1',
    render: (item) => <ListTitle code={item.code} title={item.title} />,
  };
}

function RowMenu({ item, onDelete }: Readonly<{ item: RaidItem; onDelete: (item: RaidItem) => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid.detail;
  const { abilities, openEdit } = useRaid();
  if (!abilities.update && !abilities.remove) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ListRowMenuButton label={copy.moreActions} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {abilities.update ? (
          <DropdownMenuItem onSelect={() => openEdit(item)}>
            <Pencil className="mr-0.5 h-4 w-4" />
            {copy.edit}
          </DropdownMenuItem>
        ) : null}
        {abilities.remove ? (
          <>
            {abilities.update ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(item)}>
              <Trash2 className="mr-0.5 h-4 w-4" />
              {copy.delete}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface RaidItemListProps {
  label: string;
  /** The items to list, already filtered and in register order. */
  items: RaidItem[];
  columns: RaidListColumn[];
  /** Shown when nothing is listed while no search or filter is set (e.g. only closed items, or an empty matrix cell). */
  emptyText: string;
}

/**
 * A register as the standard list: the column header and task-style rows. The
 * search and filters are the RAID toolbar's, so the list's own bar is hidden;
 * a row opens the item's detail panel.
 */
export function RaidItemList({ label, items, columns, emptyText }: Readonly<RaidItemListProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { filters, setFilters, selectedId, select } = useRaid();
  const deleteItem = useDeleteRaidItem();
  const [deleting, setDeleting] = useState<RaidItem | null>(null);
  // Previous / next in the open item panel step through the rows as listed.
  const reportDisplayedItems = useObjectPanelNavigationReporter<RaidItem>({ type: RAID_ITEM_PANEL_TYPE });

  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = columns.map(({ id, header, width }) => ({ id, header, width }));

  const renderRow = (item: RaidItem) => {
    const selected = item.id === selectedId;
    return (
      <div
        key={item.id}
        aria-current={selected ? 'true' : undefined}
        className={cn(LIST_ROW_CLASS, selected && LIST_ROW_SELECTED_CLASS)}
      >
        <ListRowTarget label={`${item.code} ${item.title}`} onClick={() => select(item.id)} />
        {columns.map((column) => (
          <div key={column.id} className={cn(LIST_CELL_CLASS, column.width)}>
            {column.render(item)}
          </div>
        ))}
        <div className={LIST_MENU_CELL_CLASS}>
          <RowMenu item={item} onDelete={setDeleting} />
        </div>
      </div>
    );
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteItem.mutateAsync(deleting.id);
      toast.success(copy.toasts.deleted);
      if (deleting.id === selectedId) select(null);
      setDeleting(null);
    } catch {
      toast.error(copy.toasts.deleteFailed);
    }
  };

  return (
    <section aria-label={label} className="@container">
      <EntityList<RaidItem>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        onDisplayedItemsChange={reportDisplayedItems}
        hideTopBar
        searchQuery={filters.search}
        onSearchChange={(search) => setFilters({ ...filters, search })}
        activeFilters={filters.filters}
        onFiltersChange={(next) => setFilters({ ...filters, filters: next })}
        noResultsState={{ title: copy.register.noMatches, description: '' }}
        emptyState={{ title: emptyText, description: '' }}
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={deleting ? format(copy.deleteDialog.title, { code: deleting.code }) : ''}
        description={deleting ? format(copy.deleteDialog.description, { title: deleting.title }) : ''}
        confirmLabel={copy.deleteDialog.confirm}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        loading={deleteItem.isPending}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
