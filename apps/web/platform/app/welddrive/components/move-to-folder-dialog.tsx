import { useState } from 'react';
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
import { useDriveFolders } from '@/hooks/queries/use-drive-queries';
import { useI18n } from '@/lib/i18n/provider';

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  fileName,
  currentFolderId,
  onMove,
}: MoveToFolderDialogProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const { data: foldersData } = useDriveFolders();
  const folders = foldersData?.data || [];
  const { t } = useI18n();

  const handleMove = () => {
    onMove(selectedFolderId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t.welddrive.moveToFolder.title.replace('{fileName}', fileName)}</DialogTitle>
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

            {folders.map((folder) => (
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
              >
                {selectedFolderId === folder.id ? (
                  <FolderOpen className="h-4 w-4 text-blue-500 shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                )}
                <span>{folder.name}</span>
                {currentFolderId === folder.id && (
                  <span className="text-xs text-muted-foreground ml-auto">{t.welddrive.moveToFolder.current}</span>
                )}
              </Button>
            ))}

            {folders.length === 0 && (
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
