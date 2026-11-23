/**
 * Create or edit an alert: what it watches (a saved insight and one of its
 * series, or an event of its own), when it fires (threshold, fast change or
 * anomaly), how often it is checked, and where it goes. A live preview runs
 * the watched series at the check interval and draws the threshold or the
 * anomaly band over it, the way the checker will judge it.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  PANEL_ANOMALY_SENSITIVITIES,
  PANEL_CHECK_INTERVALS,
  type PanelAlertCondition,
  type PanelAlertDto,
  type PanelCheckInterval,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { trendsSpecSchema, type PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoTooltip } from '@weldsuite/ui/components/info-tooltip';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Separator } from '@weldsuite/ui/components/separator';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateWeldPanelAlert, useUpdateWeldPanelAlert } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useWeldPanelLexicon, useWeldPanelReports, useWeldPanelTrends } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ChartAnnotationsProvider } from '../components/charts/annotations-context';
import { TimeSeriesChart, type ChartDatum } from '../components/charts/time-series-chart';
import { DeliveryChannelsFields } from '../components/delivery-channels-fields';
import { conditionGuides, eventAlertSpec, previewSpec } from '../lib/alerts';
import { channelsDraft, channelsInput, channelsProblem, type ChannelsDraft } from '../lib/channels';
import { formatBucket, formatNumber } from '../lib/format';

type ConditionType = PanelAlertCondition['type'];

interface AlertFormValues {
  name: string;
  source: 'report' | 'custom';
  reportId: string;
  seriesIndex: string;
  event: string;
  math: 'total' | 'unique_users';
  conditionType: ConditionType;
  operator: 'above' | 'below';
  value: string;
  direction: 'increase' | 'decrease' | 'any';
  percent: string;
  sensitivity: (typeof PANEL_ANOMALY_SENSITIVITIES)[number];
  checkInterval: PanelCheckInterval;
  enabled: boolean;
}

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function seriesOfSpec(spec: Record<string, unknown> | null | undefined): { event: string; math: string }[] {
  const series = spec?.series;
  if (!Array.isArray(series)) return [];
  return series.map((s: unknown) => {
    const item = (s ?? {}) as { event?: unknown; label?: unknown; math?: unknown };
    return { event: typeof item.label === 'string' && item.label ? item.label : String(item.event ?? ''), math: String(item.math ?? 'total') };
  });
}

function initialValues(alert: PanelAlertDto | null | undefined, reportId: string | undefined): AlertFormValues {
  const condition = alert?.condition;
  const inline = seriesOfSpec(alert?.spec)[alert?.seriesIndex ?? 0];
  const specSeries = alert?.spec?.series;
  const inlineSeries = Array.isArray(specSeries) ? (specSeries[alert?.seriesIndex ?? 0] as { event?: unknown; math?: unknown } | undefined) : undefined;
  return {
    name: alert?.name ?? '',
    // A new alert starts on a report; an existing one keeps what it watches.
    source: alert && !alert.reportId ? 'custom' : 'report',
    reportId: alert?.reportId ?? reportId ?? '',
    seriesIndex: String(alert?.seriesIndex ?? 0),
    event: typeof inlineSeries?.event === 'string' ? inlineSeries.event : (inline?.event ?? ''),
    math: inlineSeries?.math === 'unique_users' ? 'unique_users' : 'total',
    conditionType: condition?.type ?? 'threshold',
    operator: condition?.type === 'threshold' ? condition.operator : 'below',
    value: condition?.type === 'threshold' ? String(condition.value) : '',
    direction: condition?.type === 'change' ? condition.direction : 'decrease',
    percent: condition?.type === 'change' ? String(condition.percent) : '20',
    sensitivity: condition?.type === 'anomaly' ? condition.sensitivity : 'medium',
    checkInterval: alert?.checkInterval ?? 'daily',
    enabled: alert?.enabled ?? true,
  };
}

function conditionOf(values: AlertFormValues): PanelAlertCondition | null {
  if (values.conditionType === 'threshold') {
    const value = Number(values.value);
    return values.value.trim() !== '' && Number.isFinite(value) ? { type: 'threshold', operator: values.operator, value } : null;
  }
  if (values.conditionType === 'change') {
    const percent = Number(values.percent);
    return Number.isFinite(percent) && percent > 0 ? { type: 'change', direction: values.direction, percent } : null;
  }
  return { type: 'anomaly', sensitivity: values.sensitivity };
}

function Preview({ spec, seriesIndex, checkInterval, condition }: Readonly<{ spec: PanelTrendsSpec | null; seriesIndex: number; checkInterval: PanelCheckInterval; condition: PanelAlertCondition | null }>) {
  const { t, language, format } = useI18n();
  const tf = t.weldpanel.collab.alerts.form;
  const runnable = spec !== null && trendsSpecSchema.safeParse(spec).success;
  const preview = useMemo(() => (spec ? previewSpec(spec, seriesIndex, checkInterval) : null), [spec, seriesIndex, checkInterval]);
  const { data, isLoading, isError } = useWeldPanelTrends(preview ?? { kind: 'trends', projectId: '', series: [] }, { enabled: runnable && preview !== null });
  const points = data?.result.series[0]?.points ?? [];
  const values = points.map((p) => p.value);
  const interval = data?.result.interval ?? 'day';
  const chartData: ChartDatum[] = points.map((p) => ({ label: formatBucket(p.bucket, interval, language), bucket: p.bucket, v: p.value }));
  const guides = condition ? conditionGuides(condition, values) : { threshold: null, band: null };
  const lines: { value: number; label: string }[] = [];
  if (guides.threshold !== null) lines.push({ value: guides.threshold, label: tf.threshold });
  if (guides.band) lines.push({ value: guides.band.upper, label: tf.bandUpper }, { value: guides.band.lower, label: tf.bandLower });

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">{tf.previewTitle}</p>
      {!runnable && <EmptyText>{tf.previewEmpty}</EmptyText>}
      {runnable && isLoading && <Skeleton className="h-40 w-full" />}
      {runnable && isError && <EmptyText>{tf.previewFailed}</EmptyText>}
      {runnable && !isLoading && !isError && (
        <ChartAnnotationsProvider disabled>
          <TimeSeriesChart data={chartData} series={[{ key: 'v', label: seriesOfSpec(spec as Record<string, unknown>)[seriesIndex]?.event ?? '' }]} locale={language} className="h-40" guides={lines} legend={false} />
        </ChartAnnotationsProvider>
      )}
      {condition?.type === 'anomaly' && runnable && !isLoading && (
        <p className="text-xs text-muted-foreground">
          {guides.band
            ? format(tf.previewBand, { lower: formatNumber(Math.max(0, guides.band.lower), language), upper: formatNumber(guides.band.upper, language) })
            : tf.previewNoBand}
        </p>
      )}
    </div>
  );
}

interface AlertFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Edit this alert; left out: a new one. */
  alert?: PanelAlertDto | null;
  /** A new alert on this report (from the report's side panel). */
  reportId?: string;
  onSaved?: (alert: PanelAlertDto) => void;
}

export function AlertFormDialog({ open, onOpenChange, projectId, alert, reportId, onSaved }: Readonly<AlertFormDialogProps>) {
  const { t } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tf = ta.form;
  const tc = t.weldpanel.analytics.common;
  const create = useCreateWeldPanelAlert();
  const update = useUpdateWeldPanelAlert();
  const { data: reports, isLoading: reportsLoading } = useWeldPanelReports({ projectId, kind: 'trends' }, open);
  const { data: lexicon } = useWeldPanelLexicon(projectId, open);
  const [channels, setChannels] = useState<ChannelsDraft>(channelsDraft(alert?.channels));
  const [tried, setTried] = useState(false);

  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, tf.nameRequired).max(255),
          source: z.enum(['report', 'custom']),
          reportId: z.string(),
          seriesIndex: z.string(),
          event: z.string(),
          math: z.enum(['total', 'unique_users']),
          conditionType: z.enum(['threshold', 'change', 'anomaly']),
          operator: z.enum(['above', 'below']),
          value: z.string(),
          direction: z.enum(['increase', 'decrease', 'any']),
          percent: z.string(),
          sensitivity: z.enum(PANEL_ANOMALY_SENSITIVITIES),
          checkInterval: z.enum(PANEL_CHECK_INTERVALS),
          enabled: z.boolean(),
        })
        .superRefine((v, ctx) => {
          if (v.source === 'report' && v.reportId === '') ctx.addIssue({ code: 'custom', path: ['reportId'], message: tf.targetRequired });
          if (v.source === 'custom' && v.event.trim() === '') ctx.addIssue({ code: 'custom', path: ['event'], message: tf.targetRequired });
          if (v.conditionType === 'threshold' && (v.value.trim() === '' || !Number.isFinite(Number(v.value)))) ctx.addIssue({ code: 'custom', path: ['value'], message: tf.valueRequired });
          const percent = Number(v.percent);
          // NaN counts as missing too.
          if (v.conditionType === 'change' && (Number.isNaN(percent) || percent <= 0)) ctx.addIssue({ code: 'custom', path: ['percent'], message: tf.percentRequired });
        }),
    [tf.nameRequired, tf.targetRequired, tf.valueRequired, tf.percentRequired],
  );
  const form = useForm<AlertFormValues>({ resolver: zodResolver(schema), defaultValues: initialValues(alert, reportId) });

  useEffect(() => {
    if (!open) return;
    form.reset(initialValues(alert, reportId));
    setChannels(channelsDraft(alert?.channels));
    setTried(false);
  }, [open, alert, reportId, form]);

  const values = useWatch({ control: form.control }) as AlertFormValues;
  const selectedReport = (reports ?? []).find((r) => r.id === values.reportId);
  const reportSeries = seriesOfSpec(selectedReport?.spec);
  const watchedSpec = useMemo<PanelTrendsSpec | null>(() => {
    if (values.source === 'report') return selectedReport ? { ...(selectedReport.spec as PanelTrendsSpec), projectId } : null;
    return values.event?.trim() ? eventAlertSpec(projectId, values.event.trim(), values.math, browserTimezone()) : null;
  }, [values.source, values.event, values.math, selectedReport, projectId]);
  const condition = conditionOf(values);
  const events = (lexicon?.events ?? []).filter((e) => !e.hidden).map((e) => e.name);

  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(
    async (v) => {
      setTried(true);
      const cond = conditionOf(v);
      if (!cond || channelsProblem(channels)) return;
      const seriesIndex = v.source === 'report' ? Number(v.seriesIndex) || 0 : 0;
      // Only replace an alert's own spec when what it watches changed: an API-made spec may hold more than the form shows.
      const sourceChanged = !alert || (alert.reportId ? v.source !== 'report' : v.source !== 'custom');
      const customChanged = sourceChanged || form.formState.dirtyFields.event || form.formState.dirtyFields.math;
      const target =
        v.source === 'report'
          ? { reportId: v.reportId }
          : { spec: eventAlertSpec(projectId, v.event.trim(), v.math, browserTimezone()) };
      try {
        let saved: PanelAlertDto;
        if (alert) {
          const watchChanged = v.source === 'report' ? alert.reportId !== v.reportId : customChanged;
          const watch = watchChanged ? target : {};
          saved = await update.mutateAsync({
            id: alert.id,
            name: v.name.trim(),
            ...watch,
            seriesIndex,
            condition: cond,
            checkInterval: v.checkInterval,
            channels: channelsInput(channels),
            enabled: v.enabled,
          });
          toast.success(tf.saved);
        } else {
          saved = await create.mutateAsync({
            projectId,
            name: v.name.trim(),
            ...target,
            seriesIndex,
            condition: cond,
            checkInterval: v.checkInterval,
            channels: channelsInput(channels),
            enabled: v.enabled,
          });
          toast.success(tf.created);
        }
        onSaved?.(saved);
        onOpenChange(false);
      } catch {
        toast.error(tf.failed);
      }
    },
    () => setTried(true),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{alert ? tf.editTitle : tf.createTitle}</DialogTitle>
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

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="source"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.sourceLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="report">{tf.sources.report}</SelectItem>
                        <SelectItem value="custom">{tf.sources.custom}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              {/* Keyed: without a key React reuses one Controller for both names, and
                  react-hook-form unregisters the field it leaves, emptying its value. */}
              {values.source === 'report' ? (
                <FormField
                  key="reportId"
                  control={form.control}
                  name="reportId"
                  render={({ field }) => {
                    let picker: ReactNode;
                    if (reportsLoading) picker = <Skeleton className="h-9 w-full" />;
                    else if ((reports ?? []).length === 0) picker = <p className="text-sm text-muted-foreground">{tf.noReports}</p>;
                    else {
                      picker = (
                        <Select
                          value={field.value}
                          onValueChange={(next) => {
                            field.onChange(next);
                            form.setValue('seriesIndex', '0');
                          }}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={tf.reportPlaceholder} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(reports ?? []).map((report: PanelReportDto) => (
                              <SelectItem key={report.id} value={report.id}>
                                {report.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      );
                    }
                    return (
                      <FormItem>
                        <FormLabel>{tf.reportLabel}</FormLabel>
                        {picker}
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
              ) : (
                <FormField
                  key="event"
                  control={form.control}
                  name="event"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.eventLabel}</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder={tf.eventPlaceholder} list="weldpanel-alert-events" autoComplete="off" maxLength={100} />
                      </FormControl>
                      <datalist id="weldpanel-alert-events">
                        {events.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {values.source === 'report' && reportSeries.length > 1 && (
              <FormField
                control={form.control}
                name="seriesIndex"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.seriesLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {reportSeries.map((series, index) => (
                          <SelectItem key={`${index}:${series.event}`} value={String(index)}>
                            {String.fromCodePoint(65 + index)} · {series.event}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            )}
            {values.source === 'custom' && (
              <FormField
                control={form.control}
                name="math"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.mathLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="total">{tf.maths.total}</SelectItem>
                        <SelectItem value="unique_users">{tf.maths.unique_users}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            )}

            <Separator />

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="conditionType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.conditionLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(['threshold', 'change', 'anomaly'] as const).map((type) => (
                          <SelectItem key={type} value={type}>
                            {tf.conditionTypes[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="checkInterval"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center gap-1.5">
                      <FormLabel>{tf.intervalLabel}</FormLabel>
                      <InfoTooltip content={tf.intervalHint} />
                    </div>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_CHECK_INTERVALS.map((interval) => (
                          <SelectItem key={interval} value={interval}>
                            {ta.intervals[interval]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            {values.conditionType === 'threshold' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="operator"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.operatorLabel}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="above">{tf.operators.above}</SelectItem>
                          <SelectItem value="below">{tf.operators.below}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.valueLabel}</FormLabel>
                      <FormControl>
                        <Input {...field} type="number" inputMode="decimal" step="any" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
            {values.conditionType === 'change' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="direction"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.directionLabel}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(['increase', 'decrease', 'any'] as const).map((direction) => (
                            <SelectItem key={direction} value={direction}>
                              {tf.directions[direction]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="percent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.percentLabel}</FormLabel>
                      <FormControl>
                        <Input {...field} type="number" inputMode="decimal" min={1} step="any" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
            {values.conditionType === 'anomaly' && (
              <FormField
                control={form.control}
                name="sensitivity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.sensitivityLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="sm:w-60">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_ANOMALY_SENSITIVITIES.map((sensitivity) => (
                          <SelectItem key={sensitivity} value={sensitivity}>
                            {tf.sensitivities[sensitivity]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>{tf.anomalyHint}</FormDescription>
                  </FormItem>
                )}
              />
            )}

            {open && <Preview spec={watchedSpec} seriesIndex={values.source === 'report' ? Number(values.seriesIndex) || 0 : 0} checkInterval={values.checkInterval} condition={condition} />}

            <Separator />
            <DeliveryChannelsFields value={channels} onChange={setChannels} disabled={submitting} showErrors={tried} />

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <Label htmlFor="weldpanel-alert-enabled">{tf.enabledLabel}</Label>
                  <FormControl>
                    <Switch id="weldpanel-alert-enabled" checked={field.value} onCheckedChange={field.onChange} />
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
                {alert ? tf.save : tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
