/**
 * Publish an online store: the draft becomes a new version that shoppers see.
 * An optional note goes into the version history. From the editor, the draft
 * is saved first (`beforePublish`), so what is published is what is on screen.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { usePublishSite } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';

const NOTE_MAX = 500;

export function PublishDialog({
  open,
  onOpenChange,
  siteId,
  beforePublish,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  /** Resolves to false when the draft could not be saved; nothing is published then. */
  beforePublish?: () => Promise<boolean>;
}>) {
  const t = getTranslations('commerce').onlineStore.publish;
  const common = getTranslations('common');
  const tooLong = fill(getTranslations('commerce').onlineStore.validation.tooLong, { max: NOTE_MAX });
  const publish = usePublishSite();
  const form = useForm<{ note: string }>({
    resolver: zodResolver(z.object({ note: z.string().max(NOTE_MAX, tooLong) })),
    defaultValues: { note: '' },
  });

  const onSubmit = async ({ note }: { note: string }) => {
    if (beforePublish && !(await beforePublish())) {
      toast.error(t.saveFirst);
      return;
    }
    try {
      const res = await publish.mutateAsync({ siteId, note: note.trim() || undefined });
      const number = res.data?.number;
      toast.success(typeof number === 'number' ? fill(t.published, { number }) : t.publishedPlain);
      form.reset({ note: '' });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, t.failed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.note}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} maxLength={NOTE_MAX} placeholder={t.notePlaceholder} autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {t.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
