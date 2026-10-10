/** Start a pay run: the next period of a schedule (regular), or an off-cycle run for chosen employees. */

import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { createHrPayRunSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import {
  useCreateHrPayRun,
  useHrPayrollEmployees,
  useHrPayrollEmployers,
  useHrPayrollSchedules,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { periodRange } from '../lib/format';
import { SelectField, TextField } from './form-fields';

type Values = z.input<typeof createHrPayRunSchema>;
type Parsed = z.output<typeof createHrPayRunSchema>;

export function StartRunDialog({ onClose, defaultEmployerId }: Readonly<{ onClose: () => void; defaultEmployerId?: string }>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const createRun = useCreateHrPayRun();
  const { data: employers } = useHrPayrollEmployers();

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(createHrPayRunSchema),
    defaultValues: {
      employerId: defaultEmployerId ?? '',
      kind: 'regular',
      payScheduleId: null,
      periodStart: undefined,
      periodEnd: undefined,
      payDate: undefined,
      employeeIds: [],
      notes: null,
    },
  });
  const employerId = useWatch({ control: form.control, name: 'employerId' });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const failure = form.formState.errors.root?.message ?? null;

  const { data: schedules } = useHrPayrollSchedules({ employerId }, { enabled: Boolean(employerId) });
  const { data: employees } = useHrPayrollEmployees({ employerId, onPayroll: true }, { enabled: Boolean(employerId) && kind === 'off_cycle' });

  // With one employer the choice is made for the person.
  useEffect(() => {
    if (!employerId && employers?.length === 1) form.setValue('employerId', employers[0].id);
  }, [employerId, employers, form]);

  // A schedule belongs to one employer; clear it when the employer changes.
  useEffect(() => {
    const current = form.getValues('payScheduleId');
    if (current && schedules && !schedules.some((schedule) => schedule.id === current)) form.setValue('payScheduleId', null);
  }, [schedules, form]);

  async function onSubmit(values: Parsed) {
    try {
      const run = await createRun.mutateAsync({
        ...values,
        // A regular run is the schedule's next period unless a start is given.
        periodStart: values.periodStart || undefined,
        periodEnd: values.periodEnd || undefined,
        payDate: values.payDate || undefined,
        employeeIds: values.kind === 'off_cycle' ? values.employeeIds : undefined,
      });
      toast.success(t('weldhr.payroll.runs.started'));
      onClose();
      void navigate({ to: '/weldhr/payroll/runs/$runId', params: { runId: run.data.id } });
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.runs.startFailed')) });
    }
  }

  const employerOptions = (employers ?? []).filter((employer) => employer.isActive).map((employer) => ({ value: employer.id, label: employer.name }));
  const scheduleOptions = (schedules ?? [])
    .filter((schedule) => schedule.isActive)
    .map((schedule) => ({
      value: schedule.id,
      label: schedule.nextPeriod ? `${schedule.name} · ${periodRange(schedule.nextPeriod.start, schedule.nextPeriod.end)}` : schedule.name,
    }));

  return (
    <Dialog open onOpenChange={(open) => !open && !createRun.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.runs.start.title')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.runs.start.description')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            <SelectField control={form.control} name="employerId" label={t('weldhr.payroll.common.employer')} options={employerOptions} placeholder={t('weldhr.payroll.runs.start.employerPlaceholder')} />

            <SelectField
              control={form.control}
              name="kind"
              label={t('weldhr.payroll.runs.start.kind')}
              options={[
                { value: 'regular', label: t('weldhr.payroll.runKind.regular') },
                { value: 'off_cycle', label: t('weldhr.payroll.runKind.off_cycle') },
              ]}
              description={kind === 'off_cycle' ? t('weldhr.payroll.runs.start.offCycleHint') : t('weldhr.payroll.runs.start.regularHint')}
            />

            {kind === 'regular' && (
              <SelectField
                control={form.control}
                name="payScheduleId"
                label={t('weldhr.payroll.common.schedule')}
                options={scheduleOptions}
                placeholder={t('weldhr.payroll.runs.start.schedulePlaceholder')}
                disabled={!employerId}
              />
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <TextField control={form.control} name="periodStart" label={t('weldhr.payroll.runs.start.periodStart')} type="date" emptyAs="undefined" />
              <TextField control={form.control} name="periodEnd" label={t('weldhr.payroll.runs.start.periodEnd')} type="date" emptyAs="undefined" />
              <TextField control={form.control} name="payDate" label={t('weldhr.payroll.common.payDate')} type="date" emptyAs="undefined" />
            </div>
            {kind === 'regular' && <p className="-mt-2 text-xs text-muted-foreground">{t('weldhr.payroll.runs.start.optionalPeriod')}</p>}

            {kind === 'off_cycle' && (
              <FormField
                control={form.control}
                name="employeeIds"
                render={({ field }) => {
                  const selected = field.value ?? [];
                  return (
                    <FormItem>
                      <FormLabel>{t('weldhr.payroll.runs.start.employees')}</FormLabel>
                      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                        {(employees ?? []).length === 0 && (
                          <p className="px-1 py-2 text-sm text-muted-foreground">{t('weldhr.payroll.runs.start.noEmployees')}</p>
                        )}
                        {(employees ?? []).map((employee) => {
                          const checked = selected.includes(employee.employeeId);
                          return (
                            <label key={employee.employeeId} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(next) =>
                                  field.onChange(next === true ? [...selected, employee.employeeId] : selected.filter((id) => id !== employee.employeeId))
                                }
                              />
                              <span className="truncate">{employee.displayName}</span>
                            </label>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            )}

            <TextField control={form.control} name="notes" label={t('weldhr.payroll.common.notes')} multiline maxLength={2000} />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={createRun.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={createRun.isPending}>
                {createRun.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.payroll.runs.start.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
