import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { isValidDriveName, RESERVED_DRIVE_NAME_CHARS } from '@weldsuite/core-api-client/schemas/files';
import { useCreateDriveFolder } from '@/hooks/queries/use-drive-queries';
import { useI18n } from '@/lib/i18n/provider';

interface CreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string | null;
}

export function CreateFolderDialog({ open, onOpenChange, parentId }: Readonly<CreateFolderDialogProps>) {
  const [name, setName] = useState('');
  const [failed, setFailed] = useState(false);
  const createFolder = useCreateDriveFolder();
  const { t } = useI18n();
  const trimmed = name.trim();
  const invalid = trimmed !== '' && !isValidDriveName(trimmed);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || invalid) return;

    try {
      await createFolder.mutateAsync({
        name: trimmed,
        parentId: parentId || undefined,
      });
      setName('');
      setFailed(false);
      onOpenChange(false);
    } catch {
      setFailed(true);
    }
  };

  let error: string | null = null;
  if (invalid) error = t.welddrive.rename.invalidCharacters.replace('{chars}', RESERVED_DRIVE_NAME_CHARS);
  else if (failed) error = t.welddrive.createFolder.failed;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t.welddrive.createFolder.title}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="folder-name">{t.welddrive.createFolder.folderName}</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFailed(false);
              }}
              placeholder={t.welddrive.createFolder.placeholder}
              autoFocus
              aria-invalid={!!error}
              className="mt-1.5"
            />
            {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.welddrive.createFolder.cancel}
            </Button>
            <Button type="submit" disabled={!trimmed || invalid || createFolder.isPending}>
              {createFolder.isPending ? t.welddrive.createFolder.creating : t.welddrive.createFolder.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
