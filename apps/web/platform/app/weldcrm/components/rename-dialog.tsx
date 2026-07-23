
import { useTranslations } from '@weldsuite/i18n/client';
import { useState, useEffect } from 'react';
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

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onRename: (newName: string) => void;
  title?: string;
}

export function RenameDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
  title,
}: RenameDialogProps) {
  const t = useTranslations();
  const dialogTitle = title ?? t('crm.renameDialog.title');
  const [name, setName] = useState(currentName);

  useEffect(() => {
    if (open) {
      setName(currentName);
    }
  }, [open, currentName]);

  const handleRename = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) return;
    onRename(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 py-4">
          <Label htmlFor="rename-input">{t('crm.renameDialog.nameLabel')}</Label>
          <Input
            id="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && name.trim() !== currentName) {
                handleRename();
              }
            }}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('crm.renameDialog.cancel')}
          </Button>
          <Button
            onClick={handleRename}
            disabled={!name.trim() || name.trim() === currentName}
          >
            {t('crm.renameDialog.rename')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
