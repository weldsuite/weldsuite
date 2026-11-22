/**
 * The General tab of Settings → Apps → WeldCommerce: the order number (prefix
 * and next number) and the default currency. Reading is
 * `commerce_settings:read`; changing is `commerce_settings:update`.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import {
  useCommerceSettings,
  useUpdateCommerceSettings,
  type CommerceSettings,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { apiErrorInfo } from '@/app/weldcommerce/lib/orders';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { formSchemaOptions } from '@/app/weldstash/lib/form';

interface SettingsFormValues {
  orderNumberPrefix: string;
  nextOrderNumber: number;
  defaultCurrency: string;
}

function buildSchema() {
  const t = getTranslations('commerce').settings;
  return z.object({
    orderNumberPrefix: z.string().trim().max(10, t.invalidPrefix),
    // Blank is NaN (see the field), so the check is one refinement with its own message.
    nextOrderNumber: z.union([z.number(), z.nan()]).refine((value) => Number.isInteger(value) && value >= 1, t.invalidNumber),
    defaultCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/, t.invalidCurrency),
  });
}

function toFormValues(settings: CommerceSettings): SettingsFormValues {
  return {
    orderNumberPrefix: settings.orderNumberPrefix,
    nextOrderNumber: settings.nextOrderNumber,
    defaultCurrency: settings.defaultCurrency,
  };
}

/** Mounted once the stored settings are known, so the form always starts from them. */
function SettingsForm({ settings, canUpdate }: Readonly<{ settings: CommerceSettings; canUpdate: boolean }>) {
  const t = getTranslations('commerce').settings;
  const update = useUpdateCommerceSettings();
  const schema = useMemo(() => buildSchema(), []);
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: toFormValues(settings),
  });

  // Settings changed elsewhere (another tab, a refetch): follow them unless there are unsaved edits.
  const dirty = useRef(false);
  dirty.current = form.formState.isDirty;
  useEffect(() => {
    if (!dirty.current) form.reset(toFormValues(settings));
  }, [settings, form]);

  const prefix = form.watch('orderNumberPrefix');
  const next = form.watch('nextOrderNumber');
  const example = `${prefix}${next ?? settings.nextOrderNumber}`;

  const save = form.handleSubmit(async (values) => {
    try {
      // The next number is sent only when it was edited: orders move it on the server, so a stale one would be refused as going backwards.
      const res = await update.mutateAsync({
        orderNumberPrefix: values.orderNumberPrefix.trim(),
        defaultCurrency: values.defaultCurrency.trim().toUpperCase(),
        ...(form.formState.dirtyFields.nextOrderNumber ? { nextOrderNumber: values.nextOrderNumber } : {}),
      });
      form.reset(toFormValues(res.data));
      toast.success(t.saved);
    } catch (err) {
      const info = apiErrorInfo(err);
      if (info.code === 'SEQUENCE_BACKWARDS' || info.status === 409) {
        const current = typeof info.details?.current === 'number' ? info.details.current : settings.nextOrderNumber;
        form.setError('nextOrderNumber', { message: fill(t.sequenceBackwards, { current }) }, { shouldFocus: true });
        return;
      }
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  });

  const hasChanges = form.formState.isDirty;

  return (
    <div className="min-w-0 space-y-8">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {canUpdate && (
          <div className="flex items-center gap-2">
            {hasChanges && <span className="hidden text-xs text-muted-foreground sm:inline">{t.unsaved}</span>}
            <Button
              variant="outline"
              size="sm"
              disabled={!hasChanges || update.isPending}
              onClick={() => form.reset(toFormValues(settings))}
            >
              {getTranslations('common').actions.cancel}
            </Button>
            <Button size="sm" disabled={!hasChanges || update.isPending} onClick={() => void save()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {update.isPending ? t.saving : t.save}
            </Button>
          </div>
        )}
      </div>

      {!canUpdate && <InfoBanner variant="info">{t.readOnly}</InfoBanner>}

      <Form {...form}>
        <form onSubmit={save} noValidate className="max-w-2xl space-y-10">
          <fieldset disabled={!canUpdate} className="space-y-10 border-0 p-0">
            <SettingsSection title={t.sectionNumbering} description={t.sectionNumberingDescription}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="orderNumberPrefix"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t.prefix}</FormLabel>
                      <FormControl>
                        <Input {...field} maxLength={10} autoComplete="off" autoCapitalize="none" spellCheck={false} />
                      </FormControl>
                      <FormDescription>{t.prefixHint}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nextOrderNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t.nextNumber}</FormLabel>
                      <FormControl>
                        <NumberInput
                          ref={field.ref}
                          name={field.name}
                          onBlur={field.onBlur}
                          min={settings.nextOrderNumber}
                          value={field.value}
                          onValueChange={(value) => field.onChange(value ?? Number.NaN)}
                        />
                      </FormControl>
                      <FormDescription>{fill(t.nextNumberHint, { example })}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </SettingsSection>

            <SettingsSection title={t.sectionDefaults}>
              <FormField
                control={form.control}
                name="defaultCurrency"
                render={({ field }) => (
                  <FormItem className="sm:max-w-xs">
                    <FormLabel>{t.currency}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                        maxLength={3}
                        autoComplete="off"
                        spellCheck={false}
                        className="uppercase"
                      />
                    </FormControl>
                    <FormDescription>{t.currencyHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </SettingsSection>
          </fieldset>
        </form>
      </Form>
    </div>
  );
}

export function GeneralTab() {
  const t = getTranslations('commerce').settings;
  const permissions = usePermissionsMaybe();
  const canRead = permissions?.can('commerce_settings:read') ?? false;
  const canUpdate = permissions?.can('commerce_settings:update') ?? false;
  const settings = useCommerceSettings(canRead);
  // Opening the tab shows the current number: orders advance it without any settings event.
  const refetch = settings.refetch;
  useEffect(() => {
    if (canRead) void refetch();
  }, [canRead, refetch]);

  if (!canRead) return <InfoBanner variant="info">{t.loadFailed}</InfoBanner>;
  if (settings.isPending) return <PageLoader fullScreen={false} />;
  if (settings.isError || !settings.data) {
    return <ErrorState message={t.loadFailed} onRetry={() => void settings.refetch()} />;
  }
  return <SettingsForm settings={settings.data.data} canUpdate={canUpdate} />;
}
