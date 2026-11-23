/**
 * An online store's language (of the shop's own texts) and how it is built:
 * here with the theme, or with the merchant's own code uploaded as
 * deployments. Changing them needs `websites:update`.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { SHOP_LOCALES } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { useUpdateOnlineStoreSite, type OnlineStoreSite } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { errorMessage } from '@/app/weldcommerce/lib/text';

const schema = z.object({ locale: z.enum(['en', 'nl', 'de', 'fr']), mode: z.enum(['builder', 'static']) });
type Values = z.infer<typeof schema>;

export function OnlineStoreGeneralSection({ site, canUpdate }: Readonly<{ site: OnlineStoreSite; canUpdate: boolean }>) {
  const t = getTranslations('commerce').onlineStore;
  const tg = t.settingsTab.general;
  const update = useUpdateOnlineStoreSite();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { locale: site.locale, mode: site.mode } });
  const mode = form.watch('mode');

  const onSubmit = async (values: Values) => {
    const body: Partial<Values> = {};
    if (values.locale !== site.locale) body.locale = values.locale;
    if (values.mode !== site.mode) body.mode = values.mode;
    try {
      await update.mutateAsync({ siteId: site.id, data: body });
      form.reset(values);
      toast.success(tg.saved);
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <SettingsSection title={tg.title} description={tg.description}>
      {!canUpdate && <p className="text-sm text-muted-foreground">{tg.readOnly}</p>}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate aria-label={tg.title}>
          <fieldset disabled={!canUpdate} className="grid max-w-md gap-4">
            <FormField
              control={form.control}
              name="locale"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tg.language}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                    <FormControl>
                      <SelectTrigger onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SHOP_LOCALES.map((locale) => (
                        <SelectItem key={locale} value={locale}>
                          {t.locale[locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{t.create.languageHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tg.mode}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                    <FormControl>
                      <SelectTrigger onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="builder">{t.mode.builder}</SelectItem>
                      <SelectItem value="static">{t.mode.static}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>{t.modeHint[mode]}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {canUpdate && (
              <div>
                <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                  {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  {tg.save}
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </Form>
    </SettingsSection>
  );
}
