/**
 * Connects Mollie with an API key, for installs without a Mollie Connect app
 * (and as a way to replace a key). The key goes to the API once, is checked
 * against Mollie there and stored encrypted; it is never shown again, and this
 * dialog is unmounted on close, so the typed key leaves the page with it.
 * `MOLLIE_KEY_INVALID` lands on the key field.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { useConnectMollieApiKey } from '@/hooks/queries/use-commerce-payments-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import { hasErrorCode } from '@/app/weldcommerce/lib/orders';
import { paymentErrorMessage } from '@/app/weldcommerce/lib/payments';

interface KeyFormValues {
  apiKey: string;
  profileId: string;
}

function buildSchema() {
  const t = getTranslations('commerce').payments.keyDialog;
  return z.object({
    apiKey: z
      .string()
      .trim()
      .min(1, t.apiKeyRequired)
      .regex(/^(live|test)_\S+$/, t.apiKeyFormat),
    profileId: z
      .string()
      .trim()
      .max(100)
      .refine((value) => value === '' || value.startsWith('pfl_'), t.profileIdFormat),
  });
}

export function MollieKeyDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').payments;
  const tk = t.keyDialog;
  const common = getTranslations('common');
  const connect = useConnectMollieApiKey();
  const schema = useMemo(() => buildSchema(), []);
  const form = useForm<KeyFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: { apiKey: '', profileId: '' },
  });

  const onSubmit = async (values: KeyFormValues) => {
    try {
      await connect.mutateAsync({ apiKey: values.apiKey.trim(), ...(values.profileId.trim() ? { profileId: values.profileId.trim() } : {}) });
      toast.success(tk.toast);
      onOpenChange(false);
    } catch (err) {
      if (hasErrorCode(err, 'MOLLIE_KEY_INVALID')) {
        form.setError('apiKey', { message: t.errors.keyInvalid }, { shouldFocus: true });
        return;
      }
      toast.error(paymentErrorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tk.title}</DialogTitle>
          <DialogDescription>{tk.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="apiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tk.apiKey}</FormLabel>
                  <FormControl>
                    {/* A secret, not a login: masked, kept out of autofill, no spelling or case fixes. */}
                    <Input
                      {...field}
                      type="password"
                      required
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="next"
                      placeholder="live_… / test_…"
                      className="font-mono"
                    />
                  </FormControl>
                  <FormDescription>{tk.apiKeyHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="profileId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tk.profileId}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder="pfl_…" className="font-mono" />
                  </FormControl>
                  <FormDescription>{tk.profileIdHint}</FormDescription>
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
                {submitting ? tk.submitting : tk.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
