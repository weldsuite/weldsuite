/**
 * Who can visit an online store: everyone, visitors with a password, or
 * nobody yet (a coming-soon page). Changing it needs `websites:manage`. A
 * password is sent only when one is typed; an existing one is kept otherwise.
 */

import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import {
  useUpdateOnlineStoreSite,
  type OnlineStoreSite,
  type SiteVisibility,
  type UpdateSiteInput,
} from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { errorMessage } from '@/app/weldcommerce/lib/text';

const VISIBILITIES: SiteVisibility[] = ['live', 'password', 'coming_soon'];
export const PASSWORD_MIN = 6;

interface VisibilityValues {
  visibility: SiteVisibility;
  password: string;
}

export function buildVisibilitySchema(hasPassword: boolean) {
  const t = getTranslations('commerce').onlineStore.settingsTab.visibility;
  return z
    .object({ visibility: z.enum(['live', 'password', 'coming_soon']), password: z.string().max(200) })
    .superRefine((values, ctx) => {
      if (values.visibility !== 'password') return;
      const typed = values.password.length > 0;
      if ((!hasPassword || typed) && values.password.length < PASSWORD_MIN) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: t.passwordRequired });
      }
    });
}

export function toVisibilityInput(values: VisibilityValues): UpdateSiteInput {
  const body: UpdateSiteInput = { visibility: values.visibility };
  if (values.visibility === 'password' && values.password) body.password = values.password;
  return body;
}

export function OnlineStoreVisibilitySection({ site, canManage }: Readonly<{ site: OnlineStoreSite; canManage: boolean }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.visibility;
  const update = useUpdateOnlineStoreSite();
  const groupId = useId();
  const form = useForm<VisibilityValues>({
    resolver: zodResolver(buildVisibilitySchema(site.hasPassword)),
    defaultValues: { visibility: site.visibility, password: '' },
  });
  const visibility = form.watch('visibility');

  const onSubmit = async (values: VisibilityValues) => {
    try {
      const res = await update.mutateAsync({ siteId: site.id, data: toVisibilityInput(values) });
      form.reset({ visibility: res.data?.visibility ?? values.visibility, password: '' });
      toast.success(t.saved);
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <SettingsSection title={t.title} description={t.description}>
      {!canManage && <p className="text-sm text-muted-foreground">{t.readOnly}</p>}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate aria-labelledby={`${groupId}-label`}>
          <fieldset disabled={!canManage} className="grid gap-4">
            <FormField
              control={form.control}
              name="visibility"
              render={({ field }) => (
                <FormItem>
                  <FormLabel id={`${groupId}-label`} className="sr-only">
                    {t.title}
                  </FormLabel>
                  <FormControl>
                    <RadioGroup value={field.value} onValueChange={field.onChange} aria-labelledby={`${groupId}-label`} className="gap-2">
                      {VISIBILITIES.map((option) => (
                        <div key={option} className="flex items-center gap-2">
                          <RadioGroupItem value={option} id={`${groupId}-${option}`} />
                          <label htmlFor={`${groupId}-${option}`} className="text-sm">
                            {t.options[option]}
                          </label>
                        </div>
                      ))}
                    </RadioGroup>
                  </FormControl>
                </FormItem>
              )}
            />
            {visibility === 'password' && (
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="max-w-sm">
                    <FormLabel>{t.password}</FormLabel>
                    <FormControl>
                      <Input {...field} type="password" autoComplete="new-password" maxLength={200} />
                    </FormControl>
                    <FormDescription>{site.hasPassword ? t.passwordKeep : t.passwordHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {canManage && (
              <div>
                <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                  {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  {t.save}
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </Form>
    </SettingsSection>
  );
}
