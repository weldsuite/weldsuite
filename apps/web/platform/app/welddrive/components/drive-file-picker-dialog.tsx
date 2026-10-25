/**
 * Choose files from WeldDrive, for another module to use: a search box over the
 * member's files of one type, with a checkbox on each. Mount it while it is
 * open, so every opening starts empty. `onConfirm` gets the chosen files; the
 * dialog stays open, with its button busy, until that settles.
 */

import { useDeferredValue, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { useDriveFiles } from '@/hooks/queries/use-drive-queries';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { formatDate, formatFileSize } from './drive-file-card';

/** Files asked for at once; a search narrows the rest down. */
const PAGE_SIZE = 100;

interface DriveFilePickerDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** The confirm button while `onConfirm` runs. */
  pendingLabel: string;
  /** The Drive file type to list, such as `pdf`. */
  fileType: string;
  /** Leaves out files of that type that still do not fit. */
  accept?: (file: UnifiedFile) => boolean;
  /** How many files may be chosen; unlimited when left out. */
  maxSelect?: number;
  onConfirm: (files: UnifiedFile[]) => Promise<void>;
  onClose: () => void;
}

export function DriveFilePickerDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  fileType,
  accept,
  maxSelect,
  onConfirm,
  onClose,
}: Readonly<DriveFilePickerDialogProps>) {
  const { t, format } = useI18n();
  const tp = t.welddrive.picker.files;
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<ReadonlyMap<string, UnifiedFile>>(new Map());
  const [pending, setPending] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());
  const query = useDriveFiles({ type: fileType, search: deferredSearch || undefined, pageSize: PAGE_SIZE });

  const files = (query.data?.data ?? []).filter((file) => accept?.(file) ?? true);
  const full = maxSelect !== undefined && chosen.size >= maxSelect;

  const toggle = (file: UnifiedFile, checked: boolean) =>
    setChosen((previous) => {
      const next = new Map(previous);
      if (checked) next.set(file.id, file);
      else next.delete(file.id);
      return next;
    });

  async function confirm() {
    setPending(true);
    try {
      await onConfirm([...chosen.values()]);
    } finally {
      setPending(false);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          aria-label={tp.searchPlaceholder}
          placeholder={tp.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FileList
          files={files}
          isLoading={query.isLoading}
          failed={query.isError}
          limited={query.data?.pagination?.hasMore === true}
          chosen={chosen}
          full={full}
          disabled={pending}
          onToggle={toggle}
        />
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {maxSelect === undefined
              ? format(tp.selected, { count: chosen.size })
              : format(tp.selectedOf, { count: chosen.size, max: maxSelect })}
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {t.common.actions.cancel}
            </Button>
            <Button disabled={pending || chosen.size === 0} onClick={() => void confirm()}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FileListProps {
  files: UnifiedFile[];
  isLoading: boolean;
  failed: boolean;
  /** More files exist than were asked for. */
  limited: boolean;
  chosen: ReadonlyMap<string, UnifiedFile>;
  /** The selection is at its limit: unchecked files can not be added. */
  full: boolean;
  disabled: boolean;
  onToggle: (file: UnifiedFile, checked: boolean) => void;
}

function FileList({ files, isLoading, failed, limited, chosen, full, disabled, onToggle }: Readonly<FileListProps>) {
  const { t, format } = useI18n();
  const tp = t.welddrive.picker.files;

  if (isLoading) {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tp.loading}
      </p>
    );
  }
  if (failed) return <p className="py-6 text-center text-sm text-destructive">{tp.loadFailed}</p>;
  if (files.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{tp.empty}</p>;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex max-h-[50dvh] min-w-0 flex-col gap-2 overflow-y-auto">
        {files.map((file) => {
          const checked = chosen.has(file.id);
          const blocked = disabled || (full && !checked);
          return (
            <li key={file.id}>
              <label
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3 transition-colors',
                  blocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted',
                  checked && 'border-primary bg-primary/5',
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={blocked}
                  aria-label={file.name}
                  onCheckedChange={(value) => onToggle(file, value === true)}
                />
                <FileText className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={file.name}>
                    {file.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {[formatFileSize(file.fileSize), formatDate(file.updatedAt ?? file.createdAt)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {limited && <p className="text-xs text-muted-foreground">{format(tp.limited, { count: PAGE_SIZE })}</p>}
    </div>
  );
}
