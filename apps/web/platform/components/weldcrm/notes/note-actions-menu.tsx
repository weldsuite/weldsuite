import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { EllipsisVertical, Pencil, Star, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NoteActionsMenuProps {
  isPinned: boolean;
  onEdit: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

/** Edit / favourite / delete menu shown on a note row. Clicks never reach the row underneath. */
export function NoteActionsMenu({ isPinned, onEdit, onToggleFavorite, onDelete }: Readonly<NoteActionsMenuProps>) {
  const t = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
          <Pencil className="mr-0.5 h-4 w-4" />
          {t('sweep.weldcrm.notesView.edit')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}>
          <Star className={cn('mr-0.5 h-4 w-4', isPinned && 'fill-yellow-400 text-yellow-400')} />
          {isPinned ? t('sweep.weldcrm.notesView.unfavorite') : t('sweep.weldcrm.notesView.favorite')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
        >
          <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
          {t('sweep.weldcrm.notesView.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
