import type { ReactNode } from 'react';
import { Pencil, Trash2, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { EmptyStateIllustration, EntityList, type ActiveFilter, type HeaderColumn } from '@/components/entity-list';
import { useObjectPanelNavigationReporter } from '@/components/object-panel';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  LIST_CELL_CLASS,
  LIST_MENU_CELL_CLASS,
  LIST_ROW_CLASS,
  LIST_ROW_SELECTED_CLASS,
  ListPill,
  ListRowMenuButton,
  ListRowTarget,
  ListText,
} from '@/app/weldflow/components/list-cells';
import { intlLocaleOf } from '../../../raid/_lib/locale';
import { PersonAvatar } from '../../../raid/_components/raid-parts';
import { STAKEHOLDER_PANEL_TYPE } from './stakeholder-panel-type';
import { ATTITUDE_PILL, ENGAGEMENT_PILL, formatContactDate, scoreText, stakeholderName } from './stakeholder-model';

/** The first cell of a row: the person's avatar and full name. */
function StakeholderPerson({ row, avatar }: Readonly<{ row: Stakeholder; avatar: string | null }>) {
  const name = stakeholderName(row);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PersonAvatar name={name || '?'} avatar={avatar} className="size-5" />
      <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-foreground">{name || '—'}</span>
    </div>
  );
}

/** A pill of a row that gives way (with an ellipsis) when its column is narrower than its label. */
function RowPill({ tone, label }: Readonly<{ tone: string; label: string }>) {
  return (
    <ListPill className={cn(tone, 'max-w-full')}>
      <span className="truncate">{label}</span>
    </ListPill>
  );
}

interface RowMenuProps {
  row: Stakeholder;
  onEdit: (row: Stakeholder) => void;
  onRemove: (row: Stakeholder) => void;
}

/** The three-dot menu of a row: edit and remove. */
function RowMenu({ row, onEdit, onRemove }: Readonly<RowMenuProps>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ListRowMenuButton label={copy.moreActions} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(row)}>
          <Pencil className="mr-0.5 h-4 w-4" />
          {t.flowGovernance.common.edit}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onRemove(row)}>
          <Trash2 className="mr-0.5 h-4 w-4" />
          {copy.form.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One column of the list. `width` carries the column's size and, for the
 * columns that give way on a narrow list (the panel open, a phone), a container
 * breakpoint such as `hidden @3xl:flex`: the header and the rows share it, so
 * they stay aligned.
 */
interface StakeholderColumn {
  id: string;
  header: string;
  width: string;
  render: (row: Stakeholder) => ReactNode;
}

interface StakeholderListProps {
  /** The stakeholders to list, already searched and filtered. */
  rows: Stakeholder[];
  search: string;
  onSearchChange: (search: string) => void;
  filters: ActiveFilter[];
  onFiltersChange: (filters: ActiveFilter[]) => void;
  /** The stakeholder whose panel is open. */
  selectedId: string | null;
  /** The avatar of a team member, if the project has them. */
  avatarOf: (row: Stakeholder) => string | null;
  /** Whether the member may add, edit and remove stakeholders. */
  canEdit: boolean;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onEdit: (row: Stakeholder) => void;
  onRemove: (row: Stakeholder) => void;
}

/**
 * The register as the standard list: the column header and task-style rows.
 * The search and filters are the toolbar's, so the list's own bar is hidden;
 * a row opens the stakeholder's panel.
 */
export function StakeholderList({
  rows,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  selectedId,
  avatarOf,
  canEdit,
  onOpen,
  onAdd,
  onEdit,
  onRemove,
}: Readonly<StakeholderListProps>) {
  const { t, language } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const intlLocale = intlLocaleOf(language);
  // Previous / next in the open stakeholder panel step through the rows as listed.
  const reportDisplayedRows = useObjectPanelNavigationReporter<Stakeholder>({ type: STAKEHOLDER_PANEL_TYPE });

  // A narrower list (the panel open, a phone) shows fewer columns: the attitude and the scores stay longest, the last contact goes first.
  const columns: StakeholderColumn[] = [
    {
      id: 'name',
      header: copy.columns.name,
      width: 'min-w-[140px] flex-1',
      render: (row) => <StakeholderPerson row={row} avatar={avatarOf(row)} />,
    },
    { id: 'role', header: copy.form.role, width: 'hidden w-[120px] @2xl:flex', render: (row) => <ListText text={row.role} /> },
    { id: 'organisation', header: copy.form.organisation, width: 'hidden w-[120px] @3xl:flex', render: (row) => <ListText text={row.organisation} /> },
    {
      id: 'scores',
      header: `${copy.columns.influence} / ${copy.columns.interest}`,
      width: 'hidden w-[120px] @lg:flex',
      render: (row) => <ListText text={scoreText(row)} />,
    },
    {
      id: 'attitude',
      header: copy.columns.attitude,
      width: 'hidden w-[100px] @md:flex',
      render: (row) => <RowPill tone={ATTITUDE_PILL[row.attitude]} label={copy.attitudes[row.attitude]} />,
    },
    {
      id: 'engagement',
      header: copy.columns.engagement,
      width: 'hidden w-[130px] @5xl:flex',
      render: (row) => <RowPill tone={ENGAGEMENT_PILL[row.engagement]} label={copy.engagements[row.engagement]} />,
    },
    {
      id: 'lastContact',
      header: copy.columns.lastContact,
      width: 'hidden w-[100px] @6xl:flex',
      render: (row) => <ListText text={formatContactDate(row.lastContactAt, intlLocale)} />,
    },
  ];

  // EntityList adds the 40px header spacer of the menu column itself.
  const headerColumns: HeaderColumn[] = columns.map(({ id, header, width }) => ({ id, header, width }));

  const renderRow = (row: Stakeholder) => {
    const selected = row.id === selectedId;
    return (
      <div key={row.id} aria-current={selected ? 'true' : undefined} className={cn(LIST_ROW_CLASS, selected && LIST_ROW_SELECTED_CLASS)}>
        <ListRowTarget label={stakeholderName(row)} onClick={() => onOpen(row.id)} />
        {columns.map((column) => (
          <div key={column.id} className={cn(LIST_CELL_CLASS, column.width)}>
            {column.render(row)}
          </div>
        ))}
        <div className={LIST_MENU_CELL_CLASS}>{canEdit ? <RowMenu row={row} onEdit={onEdit} onRemove={onRemove} /> : null}</div>
      </div>
    );
  };

  return (
    <section aria-label={copy.title} className="@container">
      <EntityList<Stakeholder>
        items={rows}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        onDisplayedItemsChange={reportDisplayedRows}
        hideTopBar
        searchQuery={search}
        onSearchChange={onSearchChange}
        activeFilters={filters}
        onFiltersChange={onFiltersChange}
        noResultsState={{ title: copy.noMatches, description: '' }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Users className="h-12 w-12 text-gray-300 dark:text-muted-foreground" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: copy.emptyTitle,
          description: canEdit ? copy.emptyDescription : copy.emptyReadOnly,
          action: canEdit ? { label: copy.add, onClick: onAdd } : undefined,
        }}
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
      />
    </section>
  );
}
