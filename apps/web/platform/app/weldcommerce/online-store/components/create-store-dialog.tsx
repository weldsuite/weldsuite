/**
 * Create the online store of a storefront channel: the shop's language and
 * how it is built (here with the theme, or with the merchant's own code).
 * A store built here opens in the editor.
 */

import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { SHOP_LOCALES, type ShopLocale } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  onlineStoreErrorCode,
  useCreateOnlineStoreSite,
  type OnlineStoreSiteDetail,
  type SiteMode,
} from '@/hooks/queries/use-online-store-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';

const MODES: SiteMode[] = ['builder', 'static'];

const schema = z.object({
  locale: z.enum(['en', 'nl', 'de', 'fr']),
  mode: z.enum(['builder', 'static']),
});
type Values = z.infer<typeof schema>;

/** The platform's language when the shop can use it, else English. */
function defaultLocale(): ShopLocale {
  const locale = getLocale();
  return (SHOP_LOCALES as readonly string[]).includes(locale) ? (locale as ShopLocale) : 'en';
}

export function CreateStoreDialog({
  channel,
  onOpenChange,
  onCreated,
}: Readonly<{
  channel: { id: string; name: string };
  onOpenChange: (open: boolean) => void;
  onCreated: (site: OnlineStoreSiteDetail) => void;
}>) {
  const t = getTranslations('commerce').onlineStore;
  const common = getTranslations('common');
  const create = useCreateOnlineStoreSite();
  const languageId = useId();
  const modeId = useId();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { locale: defaultLocale(), mode: 'builder' } });

  const onSubmit = async (values: Values) => {
    try {
      const res = await create.mutateAsync({ channelId: channel.id, mode: values.mode, locale: values.locale });
      toast.success(t.create.created);
      onOpenChange(false);
      onCreated(res.data);
    } catch (err) {
      const code = onlineStoreErrorCode(err);
      if (code === 'SITE_EXISTS') toast.error(t.create.exists);
      // The API answers 400 for a channel that is not a native storefront channel.
      else if (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 400) toast.error(t.create.notStorefront);
      else toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.create.title}</DialogTitle>
          <DialogDescription>{fill(t.create.description, { channel: channel.name })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
            <FormField
              control={form.control}
              name="locale"
              render={({ field }) => (
                <FormItem>
                  <FormLabel id={languageId}>{t.create.language}</FormLabel>
                  <FormControl>
                    <RadioGroup value={field.value} onValueChange={field.onChange} aria-labelledby={languageId} className="grid-cols-2 gap-2">
                      {SHOP_LOCALES.map((locale) => (
                        <div key={locale} className="flex items-center gap-2">
                          <RadioGroupItem value={locale} id={`${languageId}-${locale}`} />
                          <label htmlFor={`${languageId}-${locale}`} className="text-sm">
                            {t.locale[locale]}
                          </label>
                        </div>
                      ))}
                    </RadioGroup>
                  </FormControl>
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
                  <FormLabel id={modeId}>{t.create.mode}</FormLabel>
                  <FormControl>
                    <RadioGroup value={field.value} onValueChange={field.onChange} aria-labelledby={modeId} className="gap-3">
                      {MODES.map((mode) => (
                        <div key={mode} className="flex items-start gap-2">
                          <RadioGroupItem value={mode} id={`${modeId}-${mode}`} aria-describedby={`${modeId}-${mode}-hint`} className="mt-0.5" />
                          <div className="grid gap-0.5">
                            <label htmlFor={`${modeId}-${mode}`} className="text-sm font-medium">
                              {t.mode[mode]}
                            </label>
                            <p id={`${modeId}-${mode}-hint`} className="text-sm text-muted-foreground">
                              {t.modeHint[mode]}
                            </p>
                          </div>
                        </div>
                      ))}
                    </RadioGroup>
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
                {t.create.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
