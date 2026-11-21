import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { PromptDialog } from '@weldsuite/ui/components/prompt-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import { formatMediumDateNow } from '@/lib/i18n/date-locale';
import { useI18n } from '@/lib/i18n/provider';

/** What the list needs of a document or a spreadsheet. */
export interface OfficeFile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The caller may rename and delete it. */
  canEdit: boolean;
}

/** The list's texts: the module's `home` strings fit as they are. */
export interface OfficeFileListLabels {
  untitled: string;
  columns: { name: string; updated: string; created: string };
  rename: string;
  renamePrompt: string;
  /** The row menu button's name, with `{name}`. */
  moreActions: string;
  delete: string;
  deleteTitle: string;
  deleteDescription: string;
  deletePermanently: string;
  search: string;
  noResultsTitle: string;
  noResultsDescription: string;
  emptyTitle: string;
  emptyDescription: string;
}

export interface OfficeFileListProps<T extends OfficeFile> {
  files: T[];
  labels: OfficeFileListLabels;
  /** The create button's label ("New document"); with `onCreate`. */
  createLabel?: string;
  /** The empty state's picture. */
  illustration: ReactNode;
  onOpen: (file: T) => void;
  onRename?: (file: T, name: string) => void;
  onDelete?: (file: T) => void;
  /** Toolbar button and empty-state action. */
  onCreate?: () => void;
  /** Shown next to the search box. */
  notice?: ReactNode;
  emptyStateClassName?: string;
  deletePermanently?: boolean;
}

/**
 * WeldDocs' documents and WeldSheets' spreadsheets as the standard list, like
 * WeldBoard's boards: toolbar, column header, one row per file with its menu.
 */
export function OfficeFileList<T extends OfficeFile>({
  files,
  labels,
  createLabel,
  illustration,
  onOpen,
  onRename,
  onDelete,
  onCreate,
  notice,
  emptyStateClassName,
  deletePermanently,
}: OfficeFileListProps<T>) {
  const { t, format } = useI18n();
  const [deleting, setDeleting] = useState<T | null>(null);
  const [renaming, setRenaming] = useState<T | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: labels.columns.name, width: 'flex-1 min-w-0 sm:min-w-[300px]' },
      { id: 'updated', header: labels.columns.updated, width: 'w-[140px] shrink-0 max-sm:w-auto' },
      { id: 'created', header: labels.columns.created, width: 'w-[140px] shrink-0 max-sm:hidden' },
    ],
    [labels],
  );

  const renderRow = useCallback(
    (file: T) => {
      const name = file.name || labels.untitled;
      const canRename = !!onRename && file.canEdit;
      const canDelete = !!onDelete && file.canEdit;
      return (
        <div
          key={file.id}
          className="group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50"
        >
          <RowOverlayButton label={name} onClick={() => onOpen(file)} />
          <div className="min-w-0 flex-1 sm:min-w-[300px]">
            <p className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{name}</p>
          </div>
          {/* On a phone only the last change shows, on one line; the menu then stays visible (no hover on touch). */}
          <div className="w-[140px] shrink-0 whitespace-nowrap max-sm:w-auto">
            <span className="text-sm tabular-nums">{formatMediumDateNow(file.updatedAt)}</span>
          </div>
          <div className="w-[140px] shrink-0 whitespace-nowrap max-sm:hidden">
            <span className="text-sm tabular-nums">{formatMediumDateNow(file.createdAt)}</span>
          </div>
          {/* h-7 holds the task row's 53px height on rows without a menu too. */}
          <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
            {(canRename || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={format(labels.moreActions, { name })}
                    className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <EllipsisVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canRename && (
                    <DropdownMenuItem onSelect={() => setRenaming(file)}>
                      <Pencil className="mr-0.5 h-4 w-4" />
                      {labels.rename}
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <DropdownMenuItem onSelect={() => setDeleting(file)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                      <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
                      {labels.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      );
    },
    [labels, onOpen, onRename, onDelete, format],
  );

  return (
    <>
      <EntityList<T>
        items={files}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        renderRow={renderRow}
        searchPlaceholder={labels.search}
        searchFields={['name']}
        topBarClassName="pt-2 pb-2"
        leftActionButtons={notice}
        emptyStateClassName={emptyStateClassName}
        createButton={onCreate && createLabel ? { label: createLabel, onClick: onCreate } : undefined}
        emptyState={{
          icon: illustration,
          title: labels.emptyTitle,
          description: labels.emptyDescription,
          action: onCreate && createLabel ? { label: createLabel, onClick: onCreate } : undefined,
        }}
        noResultsState={{ title: labels.noResultsTitle, description: labels.noResultsDescription, clearLabel: t.common.actions.clearSearch }}
      />
      <PromptDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={labels.rename}
        label={labels.renamePrompt}
        defaultValue={renaming?.name ?? ''}
        onConfirm={(name) => {
          if (renaming && name !== renaming.name) onRename?.(renaming, name);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={labels.deleteTitle}
        description={format(deletePermanently ? labels.deletePermanently : labels.deleteDescription, { name: deleting?.name ?? '' })}
        confirmLabel={labels.delete}
        variant="destructive"
        onConfirm={() => {
          if (deleting) onDelete?.(deleting);
          setDeleting(null);
        }}
      />
    </>
  );
}
