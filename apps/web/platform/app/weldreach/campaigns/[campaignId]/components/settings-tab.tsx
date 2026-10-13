/** The Schedule & settings tab: sending window, limits, auto-reply handling, name and owner. */

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  updateReachCampaignSchema,
  type ReachCampaignDetail,
} from '@weldsuite/app-api-client/schemas/reach';
import { useUpdateReachCampaign } from '@/hooks/queries/use-reach-campaign-queries';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { TIMEZONES } from '@/lib/timezones';
import { cn } from '@/lib/utils';
import { useReachFormat, weekdayLabels } from '@/app/weldreach/components/engage/format';
import { ErrorBanner, SectionCard, TabBody, errorMessage } from '@/app/weldreach/components/engage/kit';

const NO_OWNER = '__none__';

// Every field is edited here, so all of them are required; the window must also run forward.
const settingsSchema = updateReachCampaignSchema
  .required()
  .refine((values) => values.windowStart < values.windowEnd, {
    path: ['windowEnd'],
    message: 'windowOrder',
  });
type SettingsValues = z.infer<typeof settingsSchema>;

function toValues(campaign: ReachCampaignDetail): SettingsValues {
  return {
    name: campaign.name,
    ownerId: campaign.ownerId,
    timezone: campaign.timezone,
    sendDays: [...campaign.sendDays].sort((a, b) => a - b),
    windowStart: campaign.windowStart,
    windowEnd: campaign.windowEnd,
    dailyLimit: campaign.dailyLimit,
    minGapMinutes: campaign.minGapMinutes,
    stopOnAutoReply: campaign.stopOnAutoReply,
  };
}

export function SettingsTab({
  campaign,
  canEdit,
}: Readonly<{ campaign: ReachCampaignDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const { intlLocale } = useReachFormat();
  const update = useUpdateReachCampaign(campaign.id);
  const members = useWorkspaceMemberDirectory();
  const [failure, setFailure] = useState<string | null>(null);

  const initial = useMemo(() => toValues(campaign), [campaign]);
  const form = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: initial,
  });
  const { isDirty, errors } = form.formState;

  // Follow the server unless there are unsaved edits.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(initial);
  }, [initial, form]);

  const days = useMemo(() => weekdayLabels(intlLocale), [intlLocale]);
  const timezones = useMemo(() => {
    // A zone the campaign already uses must stay selectable even if the list lacks it.
    const known = TIMEZONES.some((zone) => zone.id === campaign.timezone);
    return known ? TIMEZONES : [{ id: campaign.timezone, label: campaign.timezone }, ...TIMEZONES];
  }, [campaign.timezone]);

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      const res = await update.mutateAsync(values);
      form.reset(toValues(res.data));
      toast.success(t('reachEngage.settings.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.settings.saveFailed')));
    }
  });

  const memberOptions = members.data?.data ?? [];

  return (
    <TabBody>
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <form onSubmit={submit} className="space-y-6">
        <fieldset disabled={!canEdit} className="m-0 min-w-0 space-y-6 border-0 p-0">
          <SectionCard title={t('reachEngage.settings.generalTitle')} contentClassName="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reach-campaign-settings-name">{t('reachEngage.settings.name')}</Label>
              <Input
                id="reach-campaign-settings-name"
                autoComplete="off"
                aria-invalid={Boolean(errors.name)}
                {...form.register('name')}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{t('reachEngage.settings.nameRequired')}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label id="reach-campaign-owner-label">{t('reachEngage.settings.owner')}</Label>
              <Controller
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? NO_OWNER}
                    onValueChange={(value) => field.onChange(value === NO_OWNER ? null : value)}
                    disabled={!canEdit}
                  >
                    <SelectTrigger aria-labelledby="reach-campaign-owner-label" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_OWNER}>{t('reachEngage.settings.noOwner')}</SelectItem>
                      {memberOptions.map((member) => (
                        <SelectItem key={member.userId} value={member.userId}>
                          {member.name || member.email || member.userId}
                        </SelectItem>
                      ))}
                      {field.value &&
                        !memberOptions.some((member) => member.userId === field.value) && (
                          <SelectItem value={field.value}>{field.value}</SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">{t('reachEngage.settings.ownerHint')}</p>
            </div>
          </SectionCard>

          <SectionCard
            title={t('reachEngage.settings.scheduleTitle')}
            description={t('reachEngage.settings.scheduleDescription')}
            contentClassName="space-y-5"
          >
            <div className="space-y-1.5">
              <Label id="reach-campaign-timezone-label">{t('reachEngage.settings.timezone')}</Label>
              <Controller
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                    <SelectTrigger aria-labelledby="reach-campaign-timezone-label" className="w-full md:max-w-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {timezones.map((zone) => (
                        <SelectItem key={zone.id} value={zone.id}>
                          {zone.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">{t('reachEngage.settings.timezoneHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label id="reach-campaign-days-label">{t('reachEngage.settings.sendDays')}</Label>
              <Controller
                control={form.control}
                name="sendDays"
                render={({ field }) => (
                  <div role="group" aria-labelledby="reach-campaign-days-label" className="flex flex-wrap gap-2">
                    {days.map(({ day, label }) => {
                      const active = field.value.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={active}
                          disabled={!canEdit}
                          onClick={() =>
                            field.onChange(
                              active
                                ? field.value.filter((value) => value !== day)
                                : [...field.value, day].sort((a, b) => a - b),
                            )
                          }
                          className={cn(
                            'h-8 min-w-12 rounded-md border px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                            active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'bg-background text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
              {errors.sendDays && (
                <p className="text-xs text-destructive">{t('reachEngage.settings.sendDaysRequired')}</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 md:max-w-md">
              <div className="space-y-1.5">
                <Label htmlFor="reach-campaign-window-start">{t('reachEngage.settings.windowStart')}</Label>
                <Input
                  id="reach-campaign-window-start"
                  type="time"
                  aria-invalid={Boolean(errors.windowStart)}
                  {...form.register('windowStart')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reach-campaign-window-end">{t('reachEngage.settings.windowEnd')}</Label>
                <Input
                  id="reach-campaign-window-end"
                  type="time"
                  aria-invalid={Boolean(errors.windowEnd)}
                  {...form.register('windowEnd')}
                />
              </div>
              {(errors.windowStart || errors.windowEnd) && (
                <p className="text-xs text-destructive sm:col-span-2">
                  {t('reachEngage.settings.windowInvalid')}
                </p>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title={t('reachEngage.settings.limitsTitle')}
            description={t('reachEngage.settings.limitsDescription')}
            contentClassName="space-y-5"
          >
            <div className="grid gap-4 sm:grid-cols-2 md:max-w-md">
              <div className="space-y-1.5">
                <Label htmlFor="reach-campaign-daily-limit">{t('reachEngage.settings.dailyLimit')}</Label>
                <Input
                  id="reach-campaign-daily-limit"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={10000}
                  aria-invalid={Boolean(errors.dailyLimit)}
                  {...form.register('dailyLimit', { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">{t('reachEngage.settings.dailyLimitHint')}</p>
                {errors.dailyLimit && (
                  <p className="text-xs text-destructive">{t('reachEngage.settings.dailyLimitInvalid')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reach-campaign-min-gap">{t('reachEngage.settings.minGap')}</Label>
                <Input
                  id="reach-campaign-min-gap"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={240}
                  aria-invalid={Boolean(errors.minGapMinutes)}
                  {...form.register('minGapMinutes', { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">{t('reachEngage.settings.minGapHint')}</p>
                {errors.minGapMinutes && (
                  <p className="text-xs text-destructive">{t('reachEngage.settings.minGapInvalid')}</p>
                )}
              </div>
            </div>

            <Controller
              control={form.control}
              name="stopOnAutoReply"
              render={({ field }) => (
                <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2 md:max-w-xl">
                  <div className="space-y-0.5">
                    <Label htmlFor="reach-campaign-stop-auto-reply" className="text-sm">
                      {t('reachEngage.settings.stopOnAutoReply')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('reachEngage.settings.stopOnAutoReplyHint')}
                    </p>
                  </div>
                  <Switch
                    id="reach-campaign-stop-auto-reply"
                    checked={field.value}
                    disabled={!canEdit}
                    onCheckedChange={field.onChange}
                  />
                </div>
              )}
            />
          </SectionCard>
        </fieldset>

        {canEdit && (
          <div className="flex items-center justify-end gap-3">
            {isDirty && (
              <>
                <span className="text-xs text-muted-foreground">{t('reachEngage.settings.unsaved')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => form.reset(initial)}
                >
                  {t('reachEngage.common.discard')}
                </Button>
              </>
            )}
            <Button type="submit" size="sm" disabled={!isDirty || update.isPending}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('reachEngage.common.save')}
            </Button>
          </div>
        )}
      </form>
    </TabBody>
  );
}
