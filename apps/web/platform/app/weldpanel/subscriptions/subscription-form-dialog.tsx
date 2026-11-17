/**
 * Create or edit a scheduled report: which report or dashboard, how often
 * (daily, a weekday, a day of the month) at which hour in which time zone,
 * and where it goes.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  PANEL_SUBSCRIPTION_FREQUENCIES,
  PANEL_SUBSCRIPTION_TARGETS,
  type PanelSubscriptionDto,
  type PanelSubscriptionFrequency,
  type PanelSubscriptionTarget,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Separator } from '@weldsuite/ui/components/separator';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateWeldPanelSubscription, useUpdateWeldPanelSubscription } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelDashboards, useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeliveryChannelsFields } from '../components/delivery-channels-fields';
import { channelsDraft, channelsInput, channelsProblem, type ChannelsDraft } from '../lib/channels';
import { hourLabel, timeZones, weekdayNames } from '../lib/schedule';

interface SubscriptionFormValues {
  name: string;
  targetType: PanelSubscriptionTarget;
  targetId: string;
  frequency: PanelSubscriptionFrequency;
  weekday: string;
  monthDay: string;
  hour: string;
  timezone: string;
  enabled: boolean;
}

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function initialValues(subscription: PanelSubscriptionDto | null | undefined, target: { targetType: PanelSubscriptionTarget; targetId: string; name?: string } | undefined): SubscriptionFormValues {
  return {
    name: subscription?.name ?? target?.name ?? '',
    targetType: subscription?.targetType ?? target?.targetType ?? 'report',
    targetId: subscription?.targetId ?? target?.targetId ?? '',
    frequency: subscription?.schedule.frequency ?? 'weekly',
    weekday: String(subscription?.schedule.weekday ?? 1),
    monthDay: String(subscription?.schedule.monthDay ?? 1),
    hour: String(subscription?.schedule.hour ?? 9),
    timezone: subscription?.schedule.timezone ?? browserTimezone(),
    enabled: subscription?.enabled ?? true,
  };
}

interface SubscriptionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  subscription?: PanelSubscriptionDto | null;
  /** A new schedule for this report or dashboard (from its side panel or page). */
  target?: { targetType: PanelSubscriptionTarget; targetId: string; name?: string };
}

export function SubscriptionFormDialog({ open, onOpenChange, projectId, subscription, target }: Readonly<SubscriptionFormDialogProps>) {
  const { t, language } = useI18n();
  const ts = t.weldpanel.collab.subscriptions;
  const tf = ts.form;
  const tc = t.weldpanel.analytics.common;
  const create = useCreateWeldPanelSubscription();
  const update = useUpdateWeldPanelSubscription();
  const [channels, setChannels] = useState<ChannelsDraft>(channelsDraft(subscription?.channels));
  const [tried, setTried] = useState(false);
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, tf.nameRequired).max(255),
        targetType: z.enum(PANEL_SUBSCRIPTION_TARGETS),
        targetId: z.string().min(1, tf.targetRequired),
        frequency: z.enum(PANEL_SUBSCRIPTION_FREQUENCIES),
        weekday: z.string(),
        monthDay: z.string(),
        hour: z.string(),
        timezone: z.string().min(1),
        enabled: z.boolean(),
      }),
    [tf.nameRequired, tf.targetRequired],
  );
  const form = useForm<SubscriptionFormValues>({ resolver: zodResolver(schema), defaultValues: initialValues(subscription, target) });
  const values = useWatch({ control: form.control }) as SubscriptionFormValues;
  const { data: reports } = useWeldPanelReports({ projectId }, open && values.targetType === 'report');
  const { data: dashboards } = useWeldPanelDashboards({ projectId }, open && values.targetType === 'dashboard');
  const targets = values.targetType === 'report' ? (reports ?? []) : (dashboards ?? []);
  const zones = useMemo(() => timeZones(values.timezone), [values.timezone]);
  const weekdays = useMemo(() => weekdayNames(language), [language]);

  // Callers pass `target` inline: compare it by value, or every render would reset the form.
  const targetKey = target ? `${target.targetType}:${target.targetId}:${target.name ?? ''}` : '';
  useEffect(() => {
    if (!open) return;
    form.reset(initialValues(subscription, target));
    setChannels(channelsDraft(subscription?.channels));
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subscription, targetKey, form]);

  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(
    async (v) => {
      setTried(true);
      if (channelsProblem(channels)) return;
      const schedule = {
        frequency: v.frequency,
        hour: Number(v.hour),
        timezone: v.timezone,
        ...(v.frequency === 'weekly' ? { weekday: Number(v.weekday) } : {}),
        ...(v.frequency === 'monthly' ? { monthDay: Number(v.monthDay) } : {}),
      };
      try {
        if (subscription) {
          await update.mutateAsync({ id: subscription.id, name: v.name.trim(), schedule, channels: channelsInput(channels), enabled: v.enabled });
          toast.success(tf.saved);
        } else {
          await create.mutateAsync({
            projectId,
            name: v.name.trim(),
            targetType: v.targetType,
            targetId: v.targetId,
            schedule,
            channels: channelsInput(channels),
            enabled: v.enabled,
          });
          toast.success(tf.created);
        }
        onOpenChange(false);
      } catch {
        toast.error(tf.failed);
      }
    },
    () => setTried(true),
  );

  // The target of a saved schedule cannot change (the API keeps it), nor a fixed one.
  const targetFixed = Boolean(subscription || target);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{subscription ? tf.editTitle : tf.createTitle}</DialogTitle>
          <DialogDescription>{ts.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.nameLabel}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tf.namePlaceholder} maxLength={255} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <FormField
                control={form.control}
                name="targetType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.targetTypeLabel}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(next) => {
                        field.onChange(next);
                        form.setValue('targetId', '');
                      }}
                      disabled={targetFixed}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_SUBSCRIPTION_TARGETS.map((type) => (
                          <SelectItem key={type} value={type}>
                            {ts.targetTypes[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="targetId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.targetLabel}</FormLabel>
                    {!targetFixed && targets.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{tf.noTargets}</p>
                    ) : (
                      <Select value={field.value} onValueChange={field.onChange} disabled={targetFixed}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={target?.name ?? tf.targetPlaceholder} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {targets.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                          {targetFixed && field.value && !targets.some((item) => item.id === field.value) && (
                            <SelectItem value={field.value}>{target?.name ?? ts.missingTarget}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="frequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.frequencyLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_SUBSCRIPTION_FREQUENCIES.map((frequency) => (
                          <SelectItem key={frequency} value={frequency}>
                            {ts.frequencies[frequency]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              {values.frequency === 'weekly' && (
                <FormField
                  control={form.control}
                  name="weekday"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.weekdayLabel}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {weekdays.map((day, index) => (
                            <SelectItem key={day} value={String(index)}>
                              {day}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}
              {values.frequency === 'monthly' && (
                <FormField
                  control={form.control}
                  name="monthDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.monthDayLabel}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((day) => (
                            <SelectItem key={day} value={day}>
                              {day}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="hour"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.hourLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, hour) => (
                          <SelectItem key={hour} value={String(hour)}>
                            {hourLabel(hour, language)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.timezoneLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="max-h-72">
                        {zones.map((zone) => (
                          <SelectItem key={zone} value={zone}>
                            {zone.replaceAll('_', ' ')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            <Separator />
            <DeliveryChannelsFields value={channels} onChange={setChannels} disabled={submitting} showErrors={tried} />

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <Label htmlFor="weldpanel-subscription-enabled">{tf.enabledLabel}</Label>
                  <FormControl>
                    <Switch id="weldpanel-subscription-enabled" checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {tc.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {subscription ? tf.save : tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
