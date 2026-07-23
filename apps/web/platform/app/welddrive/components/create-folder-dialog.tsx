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
import { useCreateDriveFolder } from '@/hooks/queries/use-drive-queries';
import { useI18n } from '@/lib/i18n/provider';

interface CreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string | null;
}

export function CreateFolderDialog({ open, onOpenChange, parentId }: CreateFolderDialogProps) {
  const [name, setName] = useState('');
  const createFolder = useCreateDriveFolder();
  const { t } = useI18n();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      await createFolder.mutateAsync({
        name: name.trim(),
        parentId: parentId || undefined,
      });
      setName('');
      onOpenChange(false);
    } catch {
      // Error handled by mutation
    }
  };

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
              onChange={(e) => setName(e.target.value)}
              placeholder={t.welddrive.createFolder.placeholder}
              autoFocus
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.welddrive.createFolder.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim() || createFolder.isPending}>
              {createFolder.isPending ? t.welddrive.createFolder.creating : t.welddrive.createFolder.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
