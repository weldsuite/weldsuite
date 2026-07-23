import { useState } from 'react';
import { FolderPlus } from 'lucide-react';
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

interface SectionCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateSection: (name: string) => void;
}

export function SectionCreateDialog({
  open,
  onOpenChange,
  onCreateSection,
}: SectionCreateDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreateSection(name.trim());
    setName('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4" />
            {t.weldchat.sectionCreate.title}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="section-name">{t.weldchat.sectionCreate.nameLabel}</Label>
            <Input
              id="section-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.weldchat.sectionCreate.namePlaceholder}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              {t.weldchat.sectionCreate.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t.weldchat.sectionCreate.create}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
