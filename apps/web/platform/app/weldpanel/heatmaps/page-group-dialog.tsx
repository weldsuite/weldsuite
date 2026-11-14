/** Create or edit a heatmap page group: a name and a path pattern such as `/products/*`. */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';

export interface PageGroupValues {
  name: string;
  urlPattern: string;
}

interface PageGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when editing. */
  initial?: PageGroupValues;
  /** Runs the mutation; the dialog closes when it resolves and stays open when it throws. */
  onSubmit: (values: PageGroupValues) => Promise<void>;
}

export function PageGroupDialog({ open, onOpenChange, initial, onSubmit }: Readonly<PageGroupDialogProps>) {
  const { t } = useI18n();
  const td = t.weldpanel.observe.heatmaps.dialog;
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t.weldpanel.validation.nameRequired).max(255),
        urlPattern: z.string().trim().min(1, t.weldpanel.validation.patternInvalid).max(1000).regex(/^\//, t.weldpanel.validation.patternInvalid),
      }),
    [t.weldpanel.validation.nameRequired, t.weldpanel.validation.patternInvalid],
  );
  const form = useForm<PageGroupValues>({ resolver: zodResolver(schema), defaultValues: { name: initial?.name ?? '', urlPattern: initial?.urlPattern ?? '' } });

  useEffect(() => {
    if (open) form.reset({ name: initial?.name ?? '', urlPattern: initial?.urlPattern ?? '' });
  }, [open, form, initial?.name, initial?.urlPattern]);

  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(async (values) => {
    try {
      await onSubmit({ name: values.name.trim(), urlPattern: values.urlPattern.trim() });
      onOpenChange(false);
    } catch {
      // The caller has already told the user why it failed; the dialog stays open for another try.
    }
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? td.editTitle : td.createTitle}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{td.name}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={td.namePlaceholder} maxLength={255} autoComplete="off" disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="urlPattern"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{td.pattern}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={td.patternPlaceholder} maxLength={1000} autoComplete="off" spellCheck={false} className="font-mono" disabled={submitting} />
                  </FormControl>
                  <FormDescription>{td.patternHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {td.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {td.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
