import { useEffect, useState, type FormEvent } from 'react';
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
import { DEFAULT_PAGE_TITLE } from '../page/default-title';

interface RenamePageDialogProps {
  pageId: string;
  initialTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RenamePageDialog({ pageId, initialTitle, open, onOpenChange }: Readonly<RenamePageDialogProps>) {
  const t = getTranslations('weldknow');
  const updatePage = useUpdateKnowledgePageMeta();
  // An untitled page is stored as "Untitled": start from an empty field with
  // the placeholder, as the page's own title does, instead of the word itself.
  const editable = (stored: string) =>
    stored === DEFAULT_PAGE_TITLE || stored === t.page.untitled ? '' : stored;
  const [title, setTitle] = useState(editable(initialTitle));

  useEffect(() => {
    if (open) setTitle(editable(initialTitle));
  }, [open, initialTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  // A form submit (Enter in the field or the Save button): the browser holds
  // it back while an IME is still composing, unlike a keydown Enter handler.
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (updatePage.isPending) return;
    try {
      await updatePage.mutateAsync({ id: pageId, data: { title: title.trim() || DEFAULT_PAGE_TITLE } });
      onOpenChange(false);
    } catch {
      toast.error(t.page.updateError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The title says it all; no description, and no console warning for it. */}
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t.sidebar.rename}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="contents">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t.page.titlePlaceholder}
            aria-label={t.sidebar.rename}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={updatePage.isPending}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={updatePage.isPending}>
              {t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
