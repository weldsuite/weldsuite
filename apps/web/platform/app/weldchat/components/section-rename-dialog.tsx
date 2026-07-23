import { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useI18n } from '@/lib/i18n/provider';

interface SectionRenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onRename: (name: string) => void;
}

export function SectionRenameDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
}: SectionRenameDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState(currentName);

  useEffect(() => {
    setName(currentName);
  }, [currentName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onRename(name.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            {t.weldchat.sectionRename.title}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="section-rename">{t.weldchat.sectionRename.nameLabel}</Label>
            <Input
              id="section-rename"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              {t.weldchat.sectionRename.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t.weldchat.sectionRename.rename}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
