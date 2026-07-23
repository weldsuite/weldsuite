import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { getTranslations } from '@/lib/i18n';
import { useUpdateKnowledgePageMeta } from '@/hooks/queries/use-knowledge-queries';

interface RenamePageDialogProps {
  pageId: string;
  initialTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RenamePageDialog({ pageId, initialTitle, open, onOpenChange }: RenamePageDialogProps) {
  const t = getTranslations('weldknow');
  const [title, setTitle] = useState(initialTitle);
  const updatePage = useUpdateKnowledgePageMeta();

  useEffect(() => {
    if (open) setTitle(initialTitle);
  }, [open, initialTitle]);

  const handleSubmit = async () => {
    try {
      await updatePage.mutateAsync({ id: pageId, data: { title: title.trim() || t.page.untitled } });
      onOpenChange(false);
    } catch {
      toast.error(t.page.updateError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t.sidebar.rename}</DialogTitle>
        </DialogHeader>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t.page.titlePlaceholder}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={updatePage.isPending}>
            {t.common.cancel}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={updatePage.isPending}>
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
