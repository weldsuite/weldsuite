import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Edit, EllipsisVertical, Power, PowerOff, Trash2 } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import {
  EntityList,
  EmptyStateIllustration,
  type ActiveFilter,
  type FilterConfig,
  type HeaderColumn,
} from '@/components/entity-list';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import {
  useCannedResponses,
  useUpdateCannedResponse,
  useDeleteCannedResponse,
} from '@/hooks/queries/use-helpdesk-queries';
import { SavedReplyEditor } from './saved-reply-editor';

interface CannedResponseItem {
  id: string;
  name: string;
  content: string;
  category?: string;
  scope: string;
  shortcut?: string;
  usageCount?: number;
  isActive: boolean;
}

/** The standard list row (the WeldFlow task row): one line, divider and hover, whole-row click. */
const ROW_CLASS =
  'group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50';

/** What a filter on `field` compares against. */
function filterValue(item: CannedResponseItem, field: string): string | null {
  switch (field) {
    case 'status':
      return item.isActive ? 'active' : 'disabled';
    case 'scope':
      return item.scope;
    case 'category':
      return item.category ?? '';
    default:
      return null;
  }
}

/** Speech bubbles with reply lines, for the empty list. */
function SavedRepliesIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="14" y="22" width="72" height="40" rx="8" className="fill-white dark:fill-white/[0.03]" />
        <rect x="14" y="22" width="72" height="40" rx="8" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="24" y="34" width="44" height="3.5" rx="1.75" className="fill-gray-300 dark:fill-white/20" opacity="0.7" />
        <rect x="24" y="44" width="34" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
        <rect x="24" y="50" width="40" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
        <rect x="36" y="70" width="72" height="34" rx="8" className="fill-white dark:fill-white/[0.03]" />
        <rect x="36" y="70" width="72" height="34" rx="8" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="46" y="81" width="38" height="3.5" rx="1.75" className="fill-gray-300 dark:fill-white/20" opacity="0.6" />
        <rect x="46" y="91" width="50" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
      </svg>
    </EmptyStateIllustration>
  );
}

/**
 * WeldDesk → Saved replies: the reply templates agents insert from the
 * composer (with `/shortcut`). The standard list: Filter, search and
 * "Create reply" in the toolbar, a column header, and one row per reply that
 * opens its editor; enabling, disabling and deleting are in the row menu.
 */
export function SavedRepliesSettings() {
  const { t } = useI18n();
  const srp = t.helpdesk.savedRepliesPage;
  const sre = t.helpdesk.savedReplyEditor;
  const scopeLabels: Record<string, string> = useMemo(
    () => ({ global: sre.global, team: sre.team, department: sre.department, personal: sre.personal }),
    [sre],
  );
  const { data: result, isLoading } = useCannedResponses();
  const updateMutation = useUpdateCannedResponse();
  const deleteMutation = useDeleteCannedResponse();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CannedResponseItem | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useBreadcrumbs([{ label: srp.helpdeskBreadcrumb, href: '/welddesk/inbox' }, { label: srp.breadcrumb }]);

  const items: CannedResponseItem[] = useMemo(() => result?.data || [], [result]);
  // The scopes the list holds, in the editor's order first; an unknown one (from an import) shows as stored.
  const scopes = useMemo(() => {
    const present = new Set(items.map((item) => item.scope));
    const known = ['global', 'team', 'department', 'personal'].filter((scope) => present.has(scope));
    return [...known, ...[...present].filter((scope) => !known.includes(scope)).sort((a, b) => a.localeCompare(b))];
  }, [items]);
  const categories = useMemo(
    () =>
      [...new Set(items.map((item) => item.category).filter((c): c is string => Boolean(c)))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [items],
  );

  const handleCreate = () => {
    setEditingItem(null);
    setEditorOpen(true);
  };

  const handleEdit = (item: CannedResponseItem) => {
    setEditingItem(item);
    setEditorOpen(true);
  };

  const handleToggleActive = async (item: CannedResponseItem) => {
    try {
      await updateMutation.mutateAsync({ id: item.id, isActive: !item.isActive });
      toast.success(
        (item.isActive
          ? t.helpdesk.ticketTypesSettings.savedReplyDisabled
          : t.helpdesk.ticketTypesSettings.savedReplyEnabled
        ).replace('{name}', item.name),
      );
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToUpdateSavedReply);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteMutation.mutateAsync(deleteId);
      toast.success(t.helpdesk.ticketTypesSettings.savedReplyDeleted);
      setDeleteId(null);
    } catch {
      toast.error(t.helpdesk.ticketTypesSettings.failedToDeleteSavedReply);
    }
  };

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: sre.nameLabel, width: 'flex-1 min-w-[220px]' },
      { id: 'shortcut', header: srp.shortcutColumn, width: 'w-[150px]' },
      { id: 'category', header: sre.categoryLabel, width: 'hidden lg:block w-[150px]' },
      { id: 'scope', header: sre.scopeLabel, width: 'w-[120px]' },
      { id: 'used', header: srp.usedColumn, width: 'hidden md:block w-[80px]' },
      { id: 'status', header: srp.statusColumn, width: 'w-[100px]' },
    ],
    [sre, srp],
  );

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      {
        field: 'status',
        label: srp.statusColumn,
        options: [
          { value: 'active', label: srp.active },
          { value: 'disabled', label: srp.disabled },
        ],
      },
      { field: 'scope', label: sre.scopeLabel, options: scopes.map((scope) => ({ value: scope, label: scopeLabels[scope] ?? scope })) },
      ...(categories.length > 0
        ? [{ field: 'category', label: sre.categoryLabel, options: categories.map((c) => ({ value: c, label: c })) }]
        : []),
    ],
    [srp, sre, scopeLabels, scopes, categories],
  );

  const applyFilters = useCallback(
    (list: CannedResponseItem[], filters: ActiveFilter[]) =>
      list.filter((item) =>
        filters.every((filter) => {
          if (!filter.operator || !filter.value) return true;
          const value = filterValue(item, filter.field);
          if (value === null) return true;
          return filter.operator === 'is' ? value === filter.value : value !== filter.value;
        }),
      ),
    [],
  );

  const renderRow = (item: CannedResponseItem) => (
    <div key={item.id} className={ROW_CLASS}>
      <RowOverlayButton label={item.name} onClick={() => handleEdit(item)} />
      <div className="min-w-[220px] flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{item.name}</p>
      </div>
      <div className="w-[150px]">
        {item.shortcut ? (
          <span className="block truncate font-mono text-sm text-gray-600 dark:text-muted-foreground">/{item.shortcut}</span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>
      <div className="hidden w-[150px] lg:block">
        {item.category ? (
          <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">{item.category}</span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>
      <div className="w-[120px]">
        <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">
          {scopeLabels[item.scope] ?? item.scope}
        </span>
      </div>
      <div className="hidden w-[80px] md:block">
        <span className="text-sm tabular-nums text-gray-600 dark:text-muted-foreground">{item.usageCount ?? 0}</span>
      </div>
      <div className="w-[100px]">
        <SoftBadge tone={item.isActive ? 'success' : 'neutral'}>{item.isActive ? srp.active : srp.disabled}</SoftBadge>
      </div>
      {/* h-7 holds the task row's 53px height. */}
      <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${t.common.actions.openMenu}: ${item.name}`}
              className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <EllipsisVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => handleEdit(item)}>
              <Edit className="mr-0.5 h-4 w-4" />
              {t.common.actions.edit}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleToggleActive(item)}>
              {item.isActive ? <PowerOff className="mr-0.5 h-4 w-4" /> : <Power className="mr-0.5 h-4 w-4" />}
              {item.isActive ? srp.disable : srp.enable}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDeleteId(item.id)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
              {t.common.actions.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EntityList<CannedResponseItem>
          items={items}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          applyFilters={applyFilters}
          renderRow={renderRow}
          searchPlaceholder={srp.searchPlaceholder}
          searchFields={['name', 'shortcut', 'content', 'category']}
          topBarClassName="pt-2 pb-2"
          createButton={{ label: srp.createReply, onClick: handleCreate }}
          emptyState={{
            icon: <SavedRepliesIllustration />,
            title: srp.noRepliesTitle,
            description: srp.noRepliesDesc,
            action: { label: srp.createFirstReply, onClick: handleCreate },
          }}
          noResultsState={{ title: srp.noResultsTitle, description: srp.noResultsDesc }}
        />
      </div>

      <SavedReplyEditor open={editorOpen} onOpenChange={setEditorOpen} editingItem={editingItem} />

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={srp.deleteTitle}
        description={srp.deleteDescription}
        confirmLabel={srp.deleteConfirm}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
