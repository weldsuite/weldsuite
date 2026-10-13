import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { updateReachSettingsSchema, type ReachSettings } from '@weldsuite/app-api-client/schemas/reach';
import { useUpdateReachSettings } from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { createReachSchemaOptions } from '@/lib/reach/zod-error-map';
import { StepFrame } from './setup-shell';

/** Step 1 asks for all three fields the footer needs; the PATCH schema has them optional. */
const identitySchema = updateReachSettingsSchema
  .pick({ senderCompanyName: true, senderAddress: true, optOutText: true })
  .required();
type IdentityInput = z.input<typeof identitySchema>;
type IdentityOutput = z.output<typeof identitySchema>;

export function IdentityStep({
  settings,
  canUpdate,
  onDone,
}: Readonly<{ settings: ReachSettings; canUpdate: boolean; onDone: () => void }>) {
  const t = useTranslations();
  const update = useUpdateReachSettings();
  const schemaOptions = useMemo(() => createReachSchemaOptions(t), [t]);

  const defaults = useMemo<IdentityInput>(
    () => ({
      senderCompanyName: settings.senderCompanyName ?? '',
      senderAddress: settings.senderAddress ?? '',
      optOutText: settings.optOutText ?? t('reach.setup.identity.defaultOptOut'),
    }),
    [settings, t],
  );

  const form = useForm<IdentityInput, unknown, IdentityOutput>({
    resolver: zodResolver(identitySchema, schemaOptions),
    defaultValues: defaults,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync(values);
      onDone();
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  });

  return (
    <StepFrame title={t('reach.setup.identity.title')} description={t('reach.setup.identity.description')}>
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <fieldset disabled={!canUpdate} className="min-w-0 space-y-4 border-0 p-0">
            <FormField
              control={form.control}
              name="senderCompanyName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('reach.setup.identity.companyName')}</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="organization"
                      placeholder={t('reach.setup.identity.companyNamePlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="senderAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('reach.setup.identity.address')}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      autoComplete="street-address"
                      placeholder={t('reach.setup.identity.addressPlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>{t('reach.setup.identity.addressHint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="optOutText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('reach.setup.identity.optOutText')}</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormDescription>{t('reach.setup.identity.optOutHint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </fieldset>
          <div className="flex justify-end border-t pt-4">
            <Button type="submit" disabled={!canUpdate || update.isPending}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('reach.setup.next')}
            </Button>
          </div>
        </form>
      </Form>
    </StepFrame>
  );
}
