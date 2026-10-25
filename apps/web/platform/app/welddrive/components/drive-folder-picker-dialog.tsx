/**
 * Choose a WeldDrive folder, for another module to use: the member's folders as
 * an indented tree. A folder they can only view is shown, since it holds the
 * ones below it, but can not be chosen. Mount it while it is open.
 */

import { useMemo, useState } from 'react';
import { Folder, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useAllDriveFolders } from '@/hooks/queries/use-drive-queries';
import type { DriveFolder } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { folderTreeOptions } from './move-to-folder-dialog';

interface DriveFolderPickerDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** The folder that is selected when the dialog opens. */
  selectedFolderId?: string | null;
  /** Called with the chosen folder; the dialog stays open, with its button busy, until it settles. */
  onPick: (folder: DriveFolder) => Promise<void>;
  onClose: () => void;
}

/** A folder files can be added to: its owner and its editors may, a viewer may not. */
export function canAddFilesTo(folder: Pick<DriveFolder, 'accessRole'>): boolean {
  return folder.accessRole !== 'viewer';
}

export function DriveFolderPickerDialog({
  title,
  description,
  confirmLabel,
  selectedFolderId = null,
  onPick,
  onClose,
}: Readonly<DriveFolderPickerDialogProps>) {
  const { t } = useI18n();
  const tp = t.welddrive.picker.folders;
  const query = useAllDriveFolders();
  const [selectedId, setSelectedId] = useState<string | null>(selectedFolderId);
  const [pending, setPending] = useState(false);
  const options = useMemo(() => folderTreeOptions(query.data?.data ?? []), [query.data]);
  const selected = options.find(({ folder }) => folder.id === selectedId)?.folder ?? null;

  async function confirm() {
    if (!selected) return;
    setPending(true);
    try {
      await onPick(selected);
    } finally {
      setPending(false);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[280px] overflow-y-auto rounded-md border">
          {query.isLoading && (
            <p className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {tp.loading}
            </p>
          )}
          {query.isError && <p className="px-3 py-6 text-center text-sm text-destructive">{tp.loadFailed}</p>}
          {!query.isLoading && !query.isError && options.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tp.empty}</p>
          )}
          {options.map(({ folder, depth }) => {
            const allowed = canAddFilesTo(folder);
            const isSelected = selectedId === folder.id;
            const Icon = isSelected ? FolderOpen : Folder;
            return (
              <Button
                key={folder.id}
                variant="ghost"
                disabled={!allowed || pending}
                aria-pressed={isSelected}
                onClick={() => setSelectedId(folder.id)}
                className={cn(
                  'h-auto w-full justify-start gap-2.5 rounded-none px-3 py-2.5 text-left text-sm',
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                style={{ paddingLeft: 12 + depth * 18 }}
              >
                <Icon className="size-4 shrink-0 text-blue-500" />
                <span className="truncate">{folder.name}</span>
                {!allowed && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{tp.viewOnly}</span>}
              </Button>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t.common.actions.cancel}
          </Button>
          <Button disabled={pending || !selected} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
