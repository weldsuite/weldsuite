/**
 * A small form dialog for naming a saved object: a name, optionally a
 * description and who can see it. Used to save a report, create a dashboard
 * and rename either. React Hook Form with a Zod resolver; the parent runs the
 * mutation in `onSubmit` and closes the dialog when it resolves.
 */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';
import { PANEL_VISIBILITIES, type PanelVisibility } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';

export interface NameDialogValues {
  name: string;
  description: string;
  visibility: PanelVisibility;
}

interface NameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  initial?: Partial<NameDialogValues>;
  namePlaceholder?: string;
  showDescription?: boolean;
  showVisibility?: boolean;
  onSubmit: (values: NameDialogValues) => Promise<void>;
}

export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initial,
  namePlaceholder,
  showDescription = false,
  showVisibility = false,
  onSubmit,
}: Readonly<NameDialogProps>) {
  const { t } = useI18n();
  const ts = t.weldpanel.analytics.save;
  const tc = t.weldpanel.analytics.common;
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, ts.nameRequired).max(255),
        description: z.string().max(2000),
        visibility: z.enum(PANEL_VISIBILITIES),
      }),
    [ts.nameRequired],
  );
  const defaults: NameDialogValues = { name: initial?.name ?? '', description: initial?.description ?? '', visibility: initial?.visibility ?? 'private' };
  const form = useForm<NameDialogValues>({ resolver: zodResolver(schema), defaultValues: defaults });

  // Every opening starts from the values it was given.
  useEffect(() => {
    if (open) form.reset({ name: initial?.name ?? '', description: initial?.description ?? '', visibility: initial?.visibility ?? 'private' });
  }, [open, form, initial?.name, initial?.description, initial?.visibility]);

  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(async (values) => {
    await onSubmit({ ...values, name: values.name.trim() });
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.nameLabel}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={namePlaceholder} maxLength={255} autoComplete="off" disabled={submitting} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {showDescription && (
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {ts.descriptionLabel} <span className="text-muted-foreground">({tc.optional})</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={2} maxLength={2000} disabled={submitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {showVisibility && (
              <FormField
                control={form.control}
                name="visibility"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tc.visibility}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={submitting}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="private">
                          {tc.private} · {tc.privateHint}
                        </SelectItem>
                        <SelectItem value="workspace">
                          {tc.workspace} · {tc.workspaceHint}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {tc.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
