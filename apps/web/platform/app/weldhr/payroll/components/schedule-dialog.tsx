/**
 * Create or edit a pay schedule. The frequency and the anchor date are fixed
 * once created (they define the periods); the name, the pay date rule and
 * whether the schedule is active can change. Dutch employers pay monthly only.
 */

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayDateRule, HrPayFrequency, HrPaySchedule, HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrPayScheduleSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useCreateHrPaySchedule, useUpdateHrPaySchedule } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { NumberField, SelectField, SwitchField, TextField } from './form-fields';

/** The create schema plus `isActive`, which only the edit form uses (the update schema has it, the create schema does not). */
const scheduleFormSchema = createHrPayScheduleSchema.extend({ isActive: z.boolean().optional() });
type Values = z.input<typeof scheduleFormSchema>;
type Parsed = z.output<typeof scheduleFormSchema>;

/** Dutch payroll is monthly in v1; the US supports the four common frequencies. */
function frequenciesFor(country: 'NL' | 'US'): HrPayFrequency[] {
  return country === 'NL' ? ['monthly'] : ['weekly', 'biweekly', 'semimonthly', 'monthly'];
}

function defaultRule(frequency: HrPayFrequency): HrPayDateRule {
  return frequency === 'monthly' || frequency === 'semimonthly' ? { kind: 'day_of_month', day: 25 } : { kind: 'offset_after_end', days: 5 };
}

export function ScheduleDialog({
  schedule,
  employers,
  defaultEmployerId,
  onClose,
}: Readonly<{
  schedule?: HrPaySchedule;
  employers: HrPayrollEmployer[];
  defaultEmployerId?: string;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const createSchedule = useCreateHrPaySchedule();
  const updateSchedule = useUpdateHrPaySchedule();
  const saving = createSchedule.isPending || updateSchedule.isPending;

  const initialEmployer = schedule?.employerId ?? defaultEmployerId ?? employers[0]?.id ?? '';
  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      employerId: initialEmployer,
      name: schedule?.name ?? '',
      frequency: schedule?.frequency ?? 'monthly',
      anchorDate: schedule?.anchorDate ?? todayIso().slice(0, 8) + '01',
      payDateRule: schedule?.payDateRule ?? defaultRule('monthly'),
      isActive: schedule?.isActive ?? true,
    },
  });
  const employerId = useWatch({ control: form.control, name: 'employerId' });
  const frequency = useWatch({ control: form.control, name: 'frequency' });
  const rule = useWatch({ control: form.control, name: 'payDateRule' });
  const failure = form.formState.errors.root?.message ?? null;

  const country = employers.find((employer) => employer.id === employerId)?.country ?? 'NL';
  const frequencies = frequenciesFor(country);

  function changeRuleKind(kind: string) {
    if (kind === 'day_of_month') form.setValue('payDateRule', { kind: 'day_of_month', day: 25 });
    else if (kind === 'offset_after_end') form.setValue('payDateRule', { kind: 'offset_after_end', days: 5 });
    else form.setValue('payDateRule', { kind: 'last_business_day' });
  }

  async function onSubmit(values: Parsed) {
    try {
      if (schedule) {
        await updateSchedule.mutateAsync({ id: schedule.id, name: values.name, payDateRule: values.payDateRule, isActive: values.isActive });
      } else {
        await createSchedule.mutateAsync({
          employerId: values.employerId,
          name: values.name,
          frequency: values.frequency,
          anchorDate: values.anchorDate,
          payDateRule: values.payDateRule,
        });
      }
      toast.success(schedule ? t('weldhr.payroll.settings.schedules.updated') : t('weldhr.payroll.settings.schedules.created'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.settings.schedules.saveFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{schedule ? t('weldhr.payroll.settings.schedules.editTitle') : t('weldhr.payroll.settings.schedules.createTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.settings.schedules.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            <SelectField
              control={form.control}
              name="employerId"
              label={t('weldhr.payroll.common.employer')}
              disabled={Boolean(schedule)}
              options={employers.map((employer) => ({ value: employer.id, label: employer.name }))}
            />
            <TextField control={form.control} name="name" label={t('weldhr.payroll.settings.schedules.name')} emptyAs="string" maxLength={120} placeholder={t('weldhr.payroll.settings.schedules.namePlaceholder')} />

            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                control={form.control}
                name="frequency"
                label={t('weldhr.payroll.settings.schedules.frequency')}
                disabled={Boolean(schedule)}
                options={frequencies.map((option) => ({ value: option, label: t(`weldhr.payroll.frequency.${option}`) }))}
                description={country === 'NL' ? t('weldhr.payroll.settings.schedules.nlMonthlyOnly') : undefined}
              />
              <TextField
                control={form.control}
                name="anchorDate"
                label={t('weldhr.payroll.settings.schedules.anchorDate')}
                type="date"
                emptyAs="string"
                disabled={Boolean(schedule)}
                description={t('weldhr.payroll.settings.schedules.anchorDateHint')}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium leading-none">{t('weldhr.payroll.settings.schedules.payDateRule')}</p>
                <RuleKindSelect value={rule.kind} onChange={changeRuleKind} />
              </div>
              {rule.kind === 'day_of_month' && (
                <NumberField control={form.control} name="payDateRule.day" label={t('weldhr.payroll.settings.schedules.dayOfMonth')} />
              )}
              {rule.kind === 'offset_after_end' && (
                <NumberField
                  control={form.control}
                  name="payDateRule.days"
                  label={t('weldhr.payroll.settings.schedules.offsetDays')}
                  description={t('weldhr.payroll.settings.schedules.offsetDaysHint')}
                />
              )}
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">{t(`weldhr.payroll.settings.schedules.ruleHelp.${rule.kind}`, { frequency: t(`weldhr.payroll.frequency.${frequency}`) })}</p>

            {schedule && <SwitchField control={form.control} name="isActive" label={t('weldhr.payroll.settings.schedules.active')} description={t('weldhr.payroll.settings.schedules.activeHint')} />}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}


/** The kind of pay date rule; a plain select (not a form field, because choosing it rewrites the whole rule object). */
function RuleKindSelect({ value, onChange }: Readonly<{ value: string; onChange: (kind: string) => void }>) {
  const t = useTranslations();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label={t('weldhr.payroll.settings.schedules.payDateRule')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="day_of_month">{t('weldhr.payroll.settings.schedules.rule.day_of_month')}</SelectItem>
        <SelectItem value="offset_after_end">{t('weldhr.payroll.settings.schedules.rule.offset_after_end')}</SelectItem>
        <SelectItem value="last_business_day">{t('weldhr.payroll.settings.schedules.rule.last_business_day')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
