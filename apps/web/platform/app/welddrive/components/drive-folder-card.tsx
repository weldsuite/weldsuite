import { Folder, MoreVertical, Pencil, Trash2, FolderInput, Copy, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DriveFolder } from '@/lib/api/domains/welddrive';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { DriveRestrictedIcon, onCardKeyDown } from './drive-file-card';

interface DriveFolderCardProps {
  folder: DriveFolder;
  isSelected?: boolean;
  /** A click, or Enter / Space on the focused card. */
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onDoubleClick?: () => void;
  onRename?: (folder: DriveFolder) => void;
  onDuplicate?: (folder: DriveFolder) => void;
  onMove?: (folder: DriveFolder) => void;
  onDelete?: (folder: DriveFolder) => void;
  onShare?: (folder: DriveFolder) => void;
}

export function DriveFolderCard({ folder, isSelected, onClick, onDoubleClick, onRename, onDuplicate, onMove, onDelete, onShare }: Readonly<DriveFolderCardProps>) {
  const { t } = useI18n();
  // A viewer opens the folder; changing it is for its owner and editors.
  const canChange = folder.accessRole !== 'viewer';
  return (
    // A div acting as a button, not a <button>: the ⋮ menu inside it is a button of its own.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => onCardKeyDown(e, onClick)}
      className={cn(
        "group relative flex flex-col rounded-lg border bg-card text-card-foreground transition-colors overflow-hidden text-left w-full cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        isSelected
          ? 'border-primary bg-primary/5 dark:bg-primary/10'
          : 'hover:bg-accent/50',
      )}
    >
      <div className="h-32 bg-muted/50 flex items-center justify-center">
        <Folder
          className={cn(
            'h-14 w-14',
            folder.color ? `text-${folder.color}-500` : 'text-blue-500'
          )}
          fill="currentColor"
          strokeWidth={1}
        />
      </div>
      <div className="p-3 flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate flex items-center gap-1" title={folder.name}>
            <span className="truncate">{folder.name}</span>
            {folder.effectiveAccess === 'restricted' && <DriveRestrictedIcon />}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t.welddrive.common.folder}</p>
        </div>
        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <button type="button" className="p-0.5 rounded-md hover:bg-muted cursor-pointer" aria-label={t.common.actions.openMenu}>
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" sideOffset={4} onClick={(e) => e.stopPropagation()}>
              {onShare && (
                <DropdownMenuItem onClick={() => onShare(folder)}>
                  <UserPlus className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.actions.share}
                </DropdownMenuItem>
              )}
              {canChange && (
                <DropdownMenuItem onClick={() => onRename?.(folder)}>
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {t.welddrive.page.actions.rename}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onDuplicate?.(folder)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.duplicate}
              </DropdownMenuItem>
              {canChange && (
                <>
                  <DropdownMenuItem onClick={() => onMove?.(folder)}>
                    <FolderInput className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.move}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                    onClick={() => onDelete?.(folder)}
                  >
                    <Trash2 className="h-4 w-4 mr-0.5" />
                    {t.welddrive.page.actions.moveToTrash}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
