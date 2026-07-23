import { Folder, MoreVertical, Pencil, Trash2, FolderInput, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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

interface DriveFolderCardProps {
  folder: DriveFolder;
  isSelected?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onRename?: (folder: DriveFolder) => void;
  onDuplicate?: (folder: DriveFolder) => void;
  onMove?: (folder: DriveFolder) => void;
  onDelete?: (folder: DriveFolder) => void;
}

export function DriveFolderCard({ folder, isSelected, onClick, onDoubleClick, onRename, onDuplicate, onMove, onDelete }: DriveFolderCardProps) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "group relative flex flex-col rounded-lg border bg-card text-card-foreground transition-colors overflow-hidden text-left w-full",
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
          <p className="text-sm font-medium truncate" title={folder.name}>
            {folder.name}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t.welddrive.common.folder}</p>
        </div>
        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className="p-0.5 rounded-md hover:bg-muted cursor-pointer">
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" sideOffset={4}>
              <DropdownMenuItem onClick={() => onRename?.(folder)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.rename}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate?.(folder)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t.welddrive.page.actions.duplicate}
              </DropdownMenuItem>
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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Button>
  );
}
