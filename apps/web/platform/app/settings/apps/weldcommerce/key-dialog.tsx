/**
 * Create and edit form for a storefront key: its kind (publishable keys go in
 * the shop's browser code and name the origins allowed to use them; private
 * keys are for servers; deploy keys upload a shop the merchant builds
 * themselves, and have no origins), a name, and the origins. A new key's secret comes
 * back from the create call and goes to `onCreated`; an edit changes only the
 * name and the origins.
 */

import { useMemo } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateChannelKey,
  useUpdateChannelKey,
  type ChannelKey,
  type ChannelKeySecret,
} from '@/hooks/queries/use-commerce-channels-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import {
  CHANNEL_KEY_KINDS,
  buildKeyFormSchema,
  emptyKeyValues,
  keyKindLabel,
  parseOrigins,
  valuesFromKey,
  type KeyFormValues,
} from '@/app/weldcommerce/lib/channels';
import { hasErrorCode } from '@/app/weldcommerce/lib/orders';
import { errorMessage } from '@/app/weldcommerce/lib/text';

function KindField({ disabled }: Readonly<{ disabled: boolean }>) {
  const t = getTranslations('commerce').channels.keys.form;
  const form = useFormContext<KeyFormValues>();
  const KIND_HINTS: Record<KeyFormValues['kind'], string> = { publishable: t.publishableHint, private: t.privateHint, deploy: t.deployHint };
  return (
    <FormField
      control={form.control}
      name="kind"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t.kind}</FormLabel>
          <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {CHANNEL_KEY_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {keyKindLabel(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>{KIND_HINTS[field.value]}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function KeyDialog({
  open,
  onOpenChange,
  channelId,
  keyToEdit,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  keyToEdit?: ChannelKey;
  onCreated?: (secret: ChannelKeySecret) => void;
}>) {
  const t = getTranslations('commerce');
  const tk = t.channels.keys;
  const common = getTranslations('common');
  const create = useCreateChannelKey();
  const update = useUpdateChannelKey();
  const schema = useMemo(() => buildKeyFormSchema(), []);
  const form = useForm<KeyFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: keyToEdit ? valuesFromKey(keyToEdit) : emptyKeyValues(),
  });
  const kind = form.watch('kind');

  const onSubmit = async (values: KeyFormValues) => {
    const allowedOrigins = values.kind === 'publishable' ? parseOrigins(values.origins) : [];
    try {
      if (keyToEdit) {
        await update.mutateAsync({
          channelId,
          keyId: keyToEdit.id,
          data: keyToEdit.kind === 'publishable' ? { name: values.name.trim(), allowedOrigins } : { name: values.name.trim() },
        });
        toast.success(tk.toastUpdated);
      } else {
        const res = await create.mutateAsync({ channelId, data: { kind: values.kind, name: values.name.trim(), allowedOrigins } });
        onCreated?.(res.data);
      }
      onOpenChange(false);
    } catch (err) {
      if (hasErrorCode(err, 'KEYS_NOT_SUPPORTED')) {
        toast.error(tk.notSupported);
        return;
      }
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{keyToEdit ? tk.editTitle : tk.newTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <KindField disabled={!!keyToEdit} />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tk.form.name}</FormLabel>
                  <FormControl>
                    <Input {...field} required maxLength={255} autoComplete="off" placeholder={tk.form.namePlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {kind === 'publishable' && (
              <FormField
                control={form.control}
                name="origins"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tk.form.origins}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        rows={3}
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="https://shop.example.com"
                        className="font-mono text-sm"
                      />
                    </FormControl>
                    <FormDescription>{tk.form.originsHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {keyToEdit ? common.actions.save : tk.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
