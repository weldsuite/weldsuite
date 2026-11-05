import { useState } from 'react';
import { MoreHorizontal, StickyNote } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardMeta } from './store/board-store';

export interface BoardListProps {
  boards: BoardMeta[];
  onOpen: (board: BoardMeta) => void;
  onRename?: (board: BoardMeta, name: string) => void;
  onDuplicate?: (board: BoardMeta) => void;
  onDelete?: (board: BoardMeta) => void;
  onToggleTemplate?: (board: BoardMeta) => void;
  /** Says where a board lives (a project's name). */
  caption?: (board: BoardMeta) => string | null;
  deletePermanently?: boolean;
}

/** Boards as a list, newest first, each with its menu. */
export function BoardList({ boards, onOpen, onRename, onDuplicate, onDelete, onToggleTemplate, caption, deletePermanently }: BoardListProps) {
  const { t, format, language } = useI18n();
  const th = t.weldboard.home;
  const [deleting, setDeleting] = useState<BoardMeta | null>(null);
  const edited = (ms: number) => format(th.edited, { time: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) });
  return (
    <>
      <ul className="divide-y rounded-lg border">
        {boards.map((board) => {
          const where = caption?.(board);
          return (
            <li key={board.id} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50">
              <StickyNote className="size-5 shrink-0 text-amber-600" aria-hidden />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(board)}>
                <span className="block truncate text-sm font-medium">{board.name}</span>
                {(where || board.legacy) && <span className="block truncate text-xs text-muted-foreground">{[where, board.legacy ? th.legacy : null].filter(Boolean).join(' · ')}</span>}
              </button>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{edited(board.updatedAt)}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={board.name}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onOpen(board)}>{th.open}</DropdownMenuItem>
                  {onRename && board.canEdit && !board.legacy && (
                    <DropdownMenuItem
                      onSelect={() => {
                        const name = window.prompt(th.renamePrompt, board.name)?.trim();
                        if (name && name !== board.name) onRename(board, name);
                      }}
                    >
                      {th.rename}
                    </DropdownMenuItem>
                  )}
                  {onDuplicate && !board.legacy && <DropdownMenuItem onSelect={() => onDuplicate(board)}>{th.duplicate}</DropdownMenuItem>}
                  {onToggleTemplate && board.canEdit && !board.legacy && !board.projectId && (
                    <DropdownMenuItem onSelect={() => onToggleTemplate(board)}>{board.templateCategory ? th.removeTemplate : th.saveAsTemplate}</DropdownMenuItem>
                  )}
                  {onDelete && board.canEdit && (
                    <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(board)}>
                      {th.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
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
