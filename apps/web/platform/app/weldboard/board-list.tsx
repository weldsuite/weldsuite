import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { BookmarkMinus, BookmarkPlus, Copy, EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { PromptDialog } from '@weldsuite/ui/components/prompt-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { TEMPLATE_CATEGORIES, type BoardTemplateCategory } from '@weldsuite/app-api-client/schemas/boards';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, EmptyStateIllustration, type GroupConfig, type HeaderColumn } from '@/components/entity-list';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import { formatMediumDateNow } from '@/lib/i18n/date-locale';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardMeta } from './store/board-store';

export interface BoardListProps {
  boards: BoardMeta[];
  onOpen: (board: BoardMeta) => void;
  onRename?: (board: BoardMeta, name: string) => void;
  onDuplicate?: (board: BoardMeta) => void;
  onDelete?: (board: BoardMeta) => void;
  /** Makes a board a workspace template in `category`, or (no category) takes it out of the templates. */
  onToggleTemplate?: (board: BoardMeta, category?: BoardTemplateCategory) => void;
  /** The project a board lives in; adds a Project column. */
  projectName?: (board: BoardMeta) => string | null;
  groups?: GroupConfig<BoardMeta>[];
  /** Toolbar button and empty-state action. */
  onCreate?: () => void;
  /** Shown next to the search box. */
  notice?: ReactNode;
  hideTopBar?: boolean;
  emptyStateClassName?: string;
  deletePermanently?: boolean;
}

/** Boards as the standard list: toolbar, column header, one row per board with its menu. */
export function BoardList({
  boards,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onToggleTemplate,
  projectName,
  groups,
  onCreate,
  notice,
  hideTopBar,
  emptyStateClassName,
  deletePermanently,
}: BoardListProps) {
  const { t, format } = useI18n();
  const th = t.weldboard.home;
  const [deleting, setDeleting] = useState<BoardMeta | null>(null);
  const [renaming, setRenaming] = useState<BoardMeta | null>(null);
  /** A board about to become a workspace template: asked first, with its category. */
  const [templating, setTemplating] = useState<BoardMeta | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: th.columns.name, width: 'flex-1 min-w-[300px]' },
      ...(projectName ? [{ id: 'project', header: th.columns.project, width: 'w-[180px]' }] : []),
      { id: 'updated', header: th.columns.updated, width: 'w-[140px]' },
      { id: 'created', header: th.columns.created, width: 'w-[140px]' },
    ],
    [th, projectName],
  );

  const renderRow = useCallback(
    (board: BoardMeta) => {
      const name = board.name || th.untitled;
      // A project's boards are renamed, copied and deleted in the project; here they only open.
      const own = !board.projectId;
      const canRename = own && !!onRename && board.canEdit && !board.legacy;
      const canDuplicate = own && !!onDuplicate && !board.legacy;
      const canTemplate = own && !!onToggleTemplate && board.canEdit && !board.legacy;
      const canDelete = own && !!onDelete && board.canEdit;
      return (
        <div
          key={board.id}
          className="group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50"
        >
          <RowOverlayButton label={name} onClick={() => onOpen(board)} />
          <div className="min-w-[300px] flex-1">
            <p className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{name}</p>
          </div>
          {projectName && (
            <div className="w-[180px] truncate text-sm text-muted-foreground">{projectName(board)}</div>
          )}
          <div className="w-[140px]">
            <span className="text-sm tabular-nums">{formatMediumDateNow(board.updatedAt)}</span>
          </div>
          <div className="w-[140px]">
            <span className="text-sm tabular-nums">{formatMediumDateNow(board.createdAt)}</span>
          </div>
          {/* h-7 holds the task row's 53px height on rows without a menu too. */}
          <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
            {(canRename || canDuplicate || canTemplate || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={format(th.moreActions, { name })}
                    className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <EllipsisVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canRename && (
                    <DropdownMenuItem onSelect={() => setRenaming(board)}>
                      <Pencil className="mr-0.5 h-4 w-4" />
                      {th.rename}
                    </DropdownMenuItem>
                  )}
                  {canDuplicate && (
                    <DropdownMenuItem onSelect={() => onDuplicate(board)}>
                      <Copy className="mr-0.5 h-4 w-4" />
                      {th.duplicate}
                    </DropdownMenuItem>
                  )}
                  {canTemplate && (
                    <DropdownMenuItem onSelect={() => (board.templateCategory ? onToggleTemplate(board) : setTemplating(board))}>
                      {board.templateCategory ? <BookmarkMinus className="mr-0.5 h-4 w-4" /> : <BookmarkPlus className="mr-0.5 h-4 w-4" />}
                      {board.templateCategory ? th.removeTemplate : th.saveAsTemplate}
                    </DropdownMenuItem>
                  )}
                  {canDelete && (canRename || canDuplicate || canTemplate) && <DropdownMenuSeparator />}
                  {canDelete && (
                    <DropdownMenuItem onSelect={() => setDeleting(board)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                      <Trash2 className="mr-0.5 h-4 w-4 text-destructive" />
                      {th.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      );
    },
    [th, format, onOpen, onRename, onDuplicate, onToggleTemplate, onDelete, projectName],
  );

  return (
    <>
      <EntityList<BoardMeta>
        items={boards}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={[]}
        groups={groups}
        renderRow={renderRow}
        searchPlaceholder={th.search}
        searchFields={['name']}
        topBarClassName="pt-2 pb-2"
        hideTopBar={hideTopBar}
        leftActionButtons={notice}
        emptyStateClassName={emptyStateClassName}
        createButton={onCreate ? { label: th.newBoard, onClick: onCreate } : undefined}
        emptyState={{
          icon: <BoardsIllustration />,
          title: th.emptyTitle,
          description: th.emptyDescription,
          action: onCreate ? { label: th.newBoard, onClick: onCreate } : undefined,
        }}
        noResultsState={{ title: th.noResultsTitle, description: th.noResultsDescription, clearLabel: t.common.actions.clearSearch }}
      />
      <PromptDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={th.rename}
        label={th.renamePrompt}
        defaultValue={renaming?.name ?? ''}
        onConfirm={(name) => {
          if (renaming && name !== renaming.name) onRename?.(renaming, name);
        }}
      />
      <SaveTemplateDialog
        board={templating}
        onClose={() => setTemplating(null)}
        onSave={(board, category) => {
          onToggleTemplate?.(board, category);
          setTemplating(null);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={th.deleteTitle}
        description={format(deletePermanently ? th.deletePermanently : th.deleteDescription, { name: deleting?.name ?? '' })}
        confirmLabel={th.delete}
        variant="destructive"
        onConfirm={() => {
          if (deleting) onDelete?.(deleting);
          setDeleting(null);
        }}
      />
    </>
  );
}

function BoardsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="14" y="14" width="92" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="14" y="14" width="92" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <rect x="30" y="36" width="28" height="20" rx="3" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.6" />
        <circle cx="80" cy="52" r="12" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.5" />
        <line x1="34" y1="78" x2="68" y2="78" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
        <path d="M72 70 L86 86" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.35" />
      </svg>
    </EmptyStateIllustration>
  );
}

/** Making a board a workspace template, which everyone can then start from: asked first, with its category. */
function SaveTemplateDialog({ board, onClose, onSave }: { board: BoardMeta | null; onClose: () => void; onSave: (board: BoardMeta, category: BoardTemplateCategory) => void }) {
  const { t } = useI18n();
  const tt = t.weldboard.templates;
  const [category, setCategory] = useState<BoardTemplateCategory>('other');
  return (
    <Dialog open={!!board} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tt.saveTitle}</DialogTitle>
          <DialogDescription>{tt.saveDescription}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="wb-template-category">{tt.category}</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as BoardTemplateCategory)}>
            <SelectTrigger id="wb-template-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {tt.categories[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.common.actions.cancel}
          </Button>
          <Button onClick={() => board && onSave(board, category)}>{tt.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
