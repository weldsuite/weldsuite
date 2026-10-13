/**
 * WeldReach settings: sender identity (the footer of every email) and sending
 * defaults in one form with a single Save, then the suppression list and the
 * billing summary. Reading is `reach_settings:read`; changing anything is
 * `reach_settings:update`.
 */

import { useEffect, useMemo, useRef } from 'react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  updateReachSettingsSchema,
  WELDREACH_SENDING_DEFAULTS,
  type ReachSettings,
} from '@weldsuite/app-api-client/schemas/reach';
import { PageLoader } from '@/components/page-loader';
import { NumberInput } from '@/components/shared/number-input';
import { useReachSettings, useUpdateReachSettings } from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { createReachSchemaOptions } from '@/lib/reach/zod-error-map';
import { TIMEZONES } from '@/lib/timezones';
import { ErrorPanel, useReachBreadcrumbs } from '../components/page-kit';
import { useBillingReturn } from '../components/use-payment-method-setup';
import { BillingSection } from './billing-section';
import { SuppressionsSection } from './suppressions-section';

/** The settings form: everything the PATCH accepts except the onboarding flag. */
const settingsFormSchema = updateReachSettingsSchema.omit({ completeOnboarding: true });
type SettingsFormInput = z.input<typeof settingsFormSchema>;
type SettingsFormOutput = z.output<typeof settingsFormSchema>;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function toFormValues(settings: ReachSettings): SettingsFormInput {
  return {
    senderCompanyName: settings.senderCompanyName ?? '',
    senderAddress: settings.senderAddress ?? '',
    optOutText: settings.optOutText ?? '',
    defaultTimezone: settings.defaultTimezone,
    defaultSendDays: settings.defaultSendDays,
    defaultWindowStart: settings.defaultWindowStart,
    defaultWindowEnd: settings.defaultWindowEnd,
    defaultMailboxDailyCap: settings.defaultMailboxDailyCap,
    stopOnReplyScope: settings.stopOnReplyScope,
  };
}

export default function ReachSettingsPage() {
  const t = useTranslations();
  useReachBreadcrumbs({ label: t('reach.nav.settings') });
  useBillingReturn();

  const settings = useReachSettings();

  if (settings.isPending) return <PageLoader fullScreen={false} label={t('reach.common.loading')} />;
  if (settings.isError || !settings.data) {
    return (
      <div className="p-6">
        <ErrorPanel onRetry={() => void settings.refetch()} />
      </div>
    );
  }
  return <SettingsForm settings={settings.data} />;
}

/** Mounted once the stored settings are known, so the form always starts from them. */
function SettingsForm({ settings }: Readonly<{ settings: ReachSettings }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const update = useUpdateReachSettings();
  const canUpdate = can('reach_settings:update');
  const schemaOptions = useMemo(() => createReachSchemaOptions(t), [t]);

  const form = useForm<SettingsFormInput, unknown, SettingsFormOutput>({
    resolver: zodResolver(settingsFormSchema, schemaOptions),
    defaultValues: toFormValues(settings),
  });

  // Settings changed elsewhere (another tab, a refetch): follow them unless there are unsaved edits.
  // Keyed on the settings only: saving makes the form clean before the refetch brings the new values.
  const dirty = useRef(false);
  dirty.current = form.formState.isDirty;
  useEffect(() => {
    if (!dirty.current) form.reset(toFormValues(settings));
  }, [settings, form]);

  const timezoneOptions = useMemo(() => {
    const current = settings.defaultTimezone;
    return TIMEZONES.some((zone) => zone.id === current) ? TIMEZONES : [{ id: current, label: current }, ...TIMEZONES];
  }, [settings.defaultTimezone]);

  const save = form.handleSubmit(async (values) => {
    try {
      const res = await update.mutateAsync(values);
      form.reset(toFormValues(res.data));
      toast.success(t('reach.settings.saved'));
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  });

  const hasChanges = form.formState.isDirty;
  const maxCap = WELDREACH_SENDING_DEFAULTS.mailboxDailyCapMax;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t('reach.settings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('reach.settings.description')}</p>
        </div>
        {canUpdate && (
          <div className="flex items-center gap-2">
            {hasChanges && <span className="hidden text-xs text-muted-foreground sm:inline">{t('reach.settings.unsaved')}</span>}
            <Button
              variant="outline"
              size="sm"
              disabled={!hasChanges || update.isPending}
              onClick={() => form.reset(toFormValues(settings))}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button size="sm" disabled={!hasChanges || update.isPending} onClick={() => void save()}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {update.isPending ? t('reach.common.saving') : t('reach.settings.save')}
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-10 px-4 py-8">
          <Form {...form}>
            <form onSubmit={save} className="space-y-10" noValidate>
              <fieldset disabled={!canUpdate} className="space-y-10 border-0 p-0">
                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold">{t('reach.settings.identity.title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('reach.settings.identity.description')}</p>
                  </div>
                  <FormField
                    control={form.control}
                    name="senderCompanyName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('reach.settings.identity.companyName')}</FormLabel>
                        <FormControl>
                          <Input autoComplete="organization" {...field} value={field.value ?? ''} />
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
                        <FormLabel>{t('reach.settings.identity.address')}</FormLabel>
                        <FormControl>
                          <Textarea rows={2} autoComplete="street-address" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="optOutText"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('reach.settings.identity.optOutText')}</FormLabel>
                        <FormControl>
                          <Textarea rows={2} {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormDescription>{t('reach.settings.identity.optOutHint')}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </section>

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold">{t('reach.settings.defaults.title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('reach.settings.defaults.description')}</p>
                  </div>

                  <FormField
                    control={form.control}
                    name="defaultTimezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('reach.settings.defaults.timezone')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full sm:max-w-md">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="max-h-80">
                            {timezoneOptions.map((zone) => (
                              <SelectItem key={zone.id} value={zone.id}>
                                {zone.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="defaultSendDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('reach.settings.defaults.sendDays')}</FormLabel>
                        <ToggleGroup
                          type="multiple"
                          variant="outline"
                          disabled={!canUpdate}
                          value={(field.value ?? []).map(String)}
                          onValueChange={(value) => field.onChange(value.map(Number).sort((a, b) => a - b))}
                          className="w-full sm:max-w-md"
                        >
                          {WEEKDAYS.map((day) => (
                            <ToggleGroupItem key={day} value={String(day)} aria-label={t(`reach.settings.weekdays.${day}`)}>
                              {t(`reach.settings.weekdays.${day}`)}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="defaultWindowStart"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('reach.settings.defaults.windowStart')}</FormLabel>
                          <FormControl>
                            <Input type="time" {...field} value={field.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="defaultWindowEnd"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('reach.settings.defaults.windowEnd')}</FormLabel>
                          <FormControl>
                            <Input type="time" {...field} value={field.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs text-muted-foreground sm:col-span-2">{t('reach.settings.defaults.windowHint')}</p>
                  </div>

                  <FormField
                    control={form.control}
                    name="defaultMailboxDailyCap"
                    render={({ field }) => (
                      <FormItem className="sm:max-w-xs">
                        <FormLabel>{t('reach.settings.defaults.dailyCap')}</FormLabel>
                        <FormControl>
                          <NumberInput
                            min={1}
                            max={maxCap}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={field.value}
                            onValueChange={field.onChange}
                          />
                        </FormControl>
                        <FormDescription>{t('reach.settings.defaults.dailyCapHint', { max: maxCap })}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="stopOnReplyScope"
                    render={({ field }) => (
                      <FormItem className="sm:max-w-md">
                        <FormLabel>{t('reach.settings.defaults.stopOnReply')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="prospect">{t('reach.settings.defaults.scope.prospect')}</SelectItem>
                            <SelectItem value="company">{t('reach.settings.defaults.scope.company')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </section>
              </fieldset>
            </form>
          </Form>

          <SuppressionsSection />
          <BillingSection />
        </div>
      </div>
    </div>
  );
}
