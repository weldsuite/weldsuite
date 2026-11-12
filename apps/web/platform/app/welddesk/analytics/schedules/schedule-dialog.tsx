/**
 * Create or edit a scheduled report email (TASK-1228). React Hook Form over
 * the shared Zod schema: the messages are translated here, the schema has the
 * last word on what the API accepts.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { toast } from 'sonner';
import {
  HELPDESK_REPORT_FREQUENCIES,
  HELPDESK_REPORT_MAX_RECIPIENTS,
  HELPDESK_REPORT_RANGES,
  createHelpdeskReportScheduleSchema,
  type CreateHelpdeskReportScheduleInput,
  type HelpdeskReportScheduleDto,
} from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { getBrowserTimezone } from '@/lib/timezones';
import { useAnalyticsReports } from '@/hooks/queries/use-helpdesk-queries';
import {
  useCreateDeskReportSchedule,
  useUpdateDeskReportSchedule,
} from '@/hooks/queries/use-desk-reports-queries';
import { RecipientsInput } from './recipients-input';
import { formatHour, type ReportSchedulesT } from './schedule-labels';

export type ScheduleFormValues = CreateHelpdeskReportScheduleInput;

/** What a dialog opened from a report page starts with. */
export interface ScheduleDialogDefaults {
  reportId?: string | null;
  range?: string;
}

const OVERVIEW = '__overview__';
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

function timeZones(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['Europe/Amsterdam', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];
  }
  const all = new Set(['UTC', ...zones]);
  if (current) all.add(current);
  return [...all];
}

function isRange(value: string | undefined): value is (typeof HELPDESK_REPORT_RANGES)[number] {
  return HELPDESK_REPORT_RANGES.some((range) => range === value);
}

/** The values a new schedule starts with. */
export function defaultScheduleValues(language: string, defaults: ScheduleDialogDefaults = {}): ScheduleFormValues {
  return {
    name: '',
    reportId: defaults.reportId ?? null,
    range: isRange(defaults.range) ? defaults.range : 'last_7_days',
    frequency: 'weekly',
    dayOfWeek: null,
    dayOfMonth: null,
    hour: 8,
    timezone: getBrowserTimezone(),
    recipients: [],
    attachCsv: true,
    locale: language === 'nl' ? 'nl' : 'en',
    enabled: true,
  };
}

function valuesFromSchedule(schedule: HelpdeskReportScheduleDto): ScheduleFormValues {
  return {
    name: schedule.name,
    reportId: schedule.reportId,
    range: schedule.range,
    frequency: schedule.frequency,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    hour: schedule.hour,
    timezone: schedule.timezone,
    recipients: schedule.recipients,
    attachCsv: schedule.attachCsv,
    locale: schedule.locale,
    enabled: schedule.enabled,
  };
}

/**
 * The request body: the day only for the frequency that has one, and the period
 * only for the overview (a saved report's charts carry their own periods).
 */
export function buildScheduleBody(values: ScheduleFormValues, forUpdate: boolean): ScheduleFormValues {
  const { reportId, range, dayOfWeek, dayOfMonth, ...rest } = values;
  const body: ScheduleFormValues = {
    ...rest,
    dayOfWeek: values.frequency === 'weekly' ? dayOfWeek : null,
    dayOfMonth: values.frequency === 'monthly' ? dayOfMonth : null,
  };
  if (reportId) {
    body.reportId = reportId;
  } else {
    body.range = range;
    if (forUpdate) body.reportId = null;
  }
  return body;
}

function makeResolver(t: ReportSchedulesT): Resolver<ScheduleFormValues> {
  return async (values) => {
    const te = t.errors;
    const errors: FieldErrors<ScheduleFormValues> = {};
    if (!values.name?.trim()) errors.name = { type: 'required', message: te.nameRequired };
    if (values.frequency === 'weekly' && (values.dayOfWeek === null || values.dayOfWeek === undefined)) {
      errors.dayOfWeek = { type: 'required', message: te.dayOfWeekRequired };
    }
    if (values.frequency === 'monthly' && (values.dayOfMonth === null || values.dayOfMonth === undefined)) {
      errors.dayOfMonth = { type: 'required', message: te.dayOfMonthRequired };
    }
    if (!values.timezone) errors.timezone = { type: 'required', message: te.timezoneInvalid };
    if (!values.recipients?.length) {
      errors.recipients = { type: 'required', message: te.recipientsRequired };
    } else if (values.recipients.length > HELPDESK_REPORT_MAX_RECIPIENTS) {
      errors.recipients = { type: 'max', message: te.recipientsMax.replace('{max}', String(HELPDESK_REPORT_MAX_RECIPIENTS)) };
    }
    if (Object.keys(errors).length > 0) return { values: {}, errors };

    // The shared schema has the last word.
    const parsed = createHelpdeskReportScheduleSchema.safeParse(buildScheduleBody(values, false));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      const key = typeof field === 'string' && field in values ? (field as keyof ScheduleFormValues) : 'name';
      return { values: {}, errors: { [key]: { type: 'schema', message: parsed.error.issues[0]?.message ?? te.nameRequired } } };
    }
    return { values, errors: {} };
  };
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  defaults,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule to edit; none creates one. */
  schedule?: HelpdeskReportScheduleDto | null;
  defaults?: ScheduleDialogDefaults;
}>) {
  const { t, language } = useI18n();
  const ts = t.helpdesk.reportSchedules;
  const td = ts.dialog;
  const editing = Boolean(schedule);
  const createMutation = useCreateDeskReportSchedule();
  const updateMutation = useUpdateDeskReportSchedule();
  const { data: reportsResult } = useAnalyticsReports();

  const resolver = useMemo(() => makeResolver(ts), [ts]);
  const form = useForm<ScheduleFormValues>({
    resolver,
    defaultValues: schedule ? valuesFromSchedule(schedule) : defaultScheduleValues(language, defaults),
  });
  const { register, watch, setValue, reset, handleSubmit, formState } = form;

  // A fresh start each time the dialog opens, on the schedule or the page it was opened from.
  const startRef = useRef<ScheduleFormValues>(defaultScheduleValues(language, defaults));
  startRef.current = schedule ? valuesFromSchedule(schedule) : defaultScheduleValues(language, defaults);
  useEffect(() => {
    if (open) reset(startRef.current);
  }, [open, reset]);

  const values = watch();
  const savedReports = reportsResult?.data ?? [];
  const reportOptions = [...savedReports.map((report) => ({ id: report.id, title: report.title }))];
  if (values.reportId && !reportOptions.some((option) => option.id === values.reportId)) {
    reportOptions.push({ id: values.reportId, title: ts.savedReportDeleted });
  }
  const zones = useMemo(() => timeZones(values.timezone ?? ''), [values.timezone]);
  const pending = createMutation.isPending || updateMutation.isPending;
  const errors = formState.errors;

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (schedule) {
        await updateMutation.mutateAsync({ id: schedule.id, input: buildScheduleBody(data, true) });
        toast.success(td.updated);
      } else {
        await createMutation.mutateAsync(buildScheduleBody(data, false));
        toast.success(td.created);
      }
      onOpenChange(false);
    } catch {
      toast.error(td.saveFailed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? td.editTitle : td.createTitle}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="schedule-name">{td.name}</Label>
            <Input id="schedule-name" placeholder={td.namePlaceholder} {...register('name')} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-report">{td.report}</Label>
              <Select
                value={values.reportId ?? OVERVIEW}
                onValueChange={(value) => setValue('reportId', value === OVERVIEW ? null : value)}
              >
                <SelectTrigger id="schedule-report" aria-label={td.report}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OVERVIEW}>{td.overviewOption}</SelectItem>
                  {reportOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {values.reportId ? (
              <p className="self-end pb-2 text-xs text-muted-foreground">{td.savedReportNote}</p>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="schedule-range">{td.period}</Label>
                <Select value={values.range} onValueChange={(value) => isRange(value) && setValue('range', value)}>
                  <SelectTrigger id="schedule-range" aria-label={td.period}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HELPDESK_REPORT_RANGES.map((range) => (
                      <SelectItem key={range} value={range}>
                        {ts.ranges[range]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{td.utcNote}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-frequency">{td.frequency}</Label>
              <Select
                value={values.frequency}
                onValueChange={(value) => {
                  const frequency = HELPDESK_REPORT_FREQUENCIES.find((option) => option === value);
                  if (frequency) setValue('frequency', frequency, { shouldValidate: formState.isSubmitted });
                }}
              >
                <SelectTrigger id="schedule-frequency" aria-label={td.frequency}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HELPDESK_REPORT_FREQUENCIES.map((frequency) => (
                    <SelectItem key={frequency} value={frequency}>
                      {td.frequencies[frequency]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {values.frequency === 'weekly' && (
              <div className="space-y-2">
                <Label htmlFor="schedule-day-of-week">{td.dayOfWeek}</Label>
                <Select
                  value={values.dayOfWeek == null ? '' : String(values.dayOfWeek)}
                  onValueChange={(value) => setValue('dayOfWeek', Number(value), { shouldValidate: formState.isSubmitted })}
                >
                  <SelectTrigger id="schedule-day-of-week" aria-label={td.dayOfWeek}>
                    <SelectValue placeholder={td.chooseDay} />
                  </SelectTrigger>
                  <SelectContent>
                    {ts.weekdays.map((day, index) => (
                      <SelectItem key={day} value={String(index)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.dayOfWeek && <p className="text-sm text-destructive">{errors.dayOfWeek.message}</p>}
              </div>
            )}

            {values.frequency === 'monthly' && (
              <div className="space-y-2">
                <Label htmlFor="schedule-day-of-month">{td.dayOfMonth}</Label>
                <Select
                  value={values.dayOfMonth == null ? '' : String(values.dayOfMonth)}
                  onValueChange={(value) => setValue('dayOfMonth', Number(value), { shouldValidate: formState.isSubmitted })}
                >
                  <SelectTrigger id="schedule-day-of-month" aria-label={td.dayOfMonth}>
                    <SelectValue placeholder={td.chooseDay} />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_DAYS.map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.dayOfMonth && <p className="text-sm text-destructive">{errors.dayOfMonth.message}</p>}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-hour">{td.hour}</Label>
              <Select value={String(values.hour)} onValueChange={(value) => setValue('hour', Number(value))}>
                <SelectTrigger id="schedule-hour" aria-label={td.hour}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((hour) => (
                    <SelectItem key={hour} value={String(hour)}>
                      {formatHour(hour)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-timezone">{td.timezone}</Label>
              <Select value={values.timezone} onValueChange={(value) => setValue('timezone', value)}>
                <SelectTrigger id="schedule-timezone" aria-label={td.timezone}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.timezone && <p className="text-sm text-destructive">{errors.timezone.message}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-recipients">{td.recipients}</Label>
            <RecipientsInput
              id="schedule-recipients"
              value={values.recipients ?? []}
              onChange={(next) => setValue('recipients', next, { shouldValidate: formState.isSubmitted })}
              max={HELPDESK_REPORT_MAX_RECIPIENTS}
              labels={{
                placeholder: td.recipientsPlaceholder,
                invalid: (email) => ts.errors.recipientInvalid.replace('{email}', email),
                tooMany: ts.errors.recipientsMax.replace('{max}', String(HELPDESK_REPORT_MAX_RECIPIENTS)),
                remove: (email) => td.removeRecipient.replace('{email}', email),
              }}
            />
            <p className="text-xs text-muted-foreground">
              {td.recipientsHint.replace('{max}', String(HELPDESK_REPORT_MAX_RECIPIENTS))}
            </p>
            {errors.recipients && <p className="text-sm text-destructive">{errors.recipients.message}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-locale">{td.locale}</Label>
              <Select
                value={values.locale ?? 'en'}
                onValueChange={(value) => setValue('locale', value === 'nl' ? 'nl' : 'en')}
              >
                <SelectTrigger id="schedule-locale" aria-label={td.locale}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">{td.locales.en}</SelectItem>
                  <SelectItem value="nl">{td.locales.nl}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col justify-end gap-3 pb-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="schedule-attach-csv"
                  checked={values.attachCsv ?? true}
                  onCheckedChange={(checked) => setValue('attachCsv', checked === true)}
                />
                <Label htmlFor="schedule-attach-csv">{td.attachCsv}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="schedule-enabled"
                  checked={values.enabled ?? true}
                  onCheckedChange={(checked) => setValue('enabled', checked)}
                />
                <Label htmlFor="schedule-enabled">{td.enabled}</Label>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {td.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? td.saving : td.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
