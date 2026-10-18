import { useEffect, useMemo, useState } from 'react';
import { Folder, FolderOpen, Home } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useAllDriveFolders } from '@/hooks/queries/use-drive-queries';
import type { DriveFolder } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name of the file or folder being moved, for the title. */
  itemName: string;
  currentFolderId: string | null;
  /** When a folder is moved: it and its subfolders can't be the destination. */
  movingFolderId?: string | null;
  onMove: (folderId: string | null) => void;
}

interface FolderOption {
  folder: DriveFolder;
  depth: number;
}

/**
 * Every folder as an indented tree (depth-first, by name), leaving out
 * `excludeId` and everything under it.
 */
export function folderTreeOptions(folders: DriveFolder[], excludeId?: string | null): FolderOption[] {
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, DriveFolder[]>();
  for (const folder of folders) {
    // A folder whose parent isn't listed (trashed) shows at the top level.
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(folder);
    children.set(parent, list);
  }
  const options: FolderOption[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const list = [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of list) {
      if (folder.id === excludeId || seen.has(folder.id)) continue;
      seen.add(folder.id);
      options.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  itemName,
  currentFolderId,
  movingFolderId,
  onMove,
}: Readonly<MoveToFolderDialogProps>) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(currentFolderId);
  const { data: foldersData } = useAllDriveFolders();
  const { t } = useI18n();
  const options = useMemo(
    () => folderTreeOptions(foldersData?.data || [], movingFolderId),
    [foldersData, movingFolderId],
  );

  useEffect(() => {
    if (open) setSelectedFolderId(currentFolderId);
  }, [open, currentFolderId]);

  const handleMove = () => {
    onMove(selectedFolderId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{t.welddrive.moveToFolder.title.replace('{fileName}', itemName)}</DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <p className="text-sm text-muted-foreground mb-3">{t.welddrive.moveToFolder.selectDestination}</p>
          <div className="border rounded-md max-h-[280px] overflow-y-auto">
            {/* Root / My Drive option */}
            <Button
              variant="ghost"
              onClick={() => setSelectedFolderId(null)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors h-auto justify-start rounded-none',
                selectedFolderId === null
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted'
              )}
            >
              <Home className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">{t.welddrive.moveToFolder.myDrive}</span>
              {currentFolderId === null && (
                <span className="text-xs text-muted-foreground ml-auto">{t.welddrive.moveToFolder.current}</span>
              )}
            </Button>

            {options.map(({ folder, depth }) => (
              <Button
                key={folder.id}
                variant="ghost"
                onClick={() => setSelectedFolderId(folder.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition-colors h-auto justify-start rounded-none',
                  selectedFolderId === folder.id
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted'
                )}
                style={{ paddingLeft: 12 + depth * 18 }}
              >
                {selectedFolderId === folder.id ? (
                  <FolderOpen className="h-4 w-4 text-blue-500 shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                )}
                <span className="truncate">{folder.name}</span>
                {currentFolderId === folder.id && (
                  <span className="text-xs text-muted-foreground ml-auto">{t.welddrive.moveToFolder.current}</span>
                )}
              </Button>
            ))}

            {options.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t.welddrive.moveToFolder.noFolders}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.welddrive.moveToFolder.cancel}
          </Button>
          <Button
            onClick={handleMove}
            disabled={selectedFolderId === currentFolderId}
          >
            {t.welddrive.moveToFolder.moveHere}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
