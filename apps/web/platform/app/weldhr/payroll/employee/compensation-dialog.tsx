/** Add a pay rate (salary or hourly) from a date. Rates are effective-dated: a new one ends the previous one. */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrCompensationSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useCreateHrCompensation } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { NumberField, SelectField, SwitchField, TextField } from '../components/form-fields';

type Values = z.input<typeof createHrCompensationSchema>;
type Parsed = z.output<typeof createHrCompensationSchema>;

export function CompensationDialog({ employeeId, detail, onClose }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; onClose: () => void }>) {
  const t = useTranslations();
  const create = useCreateHrCompensation();
  const current = detail.compensations.find((row) => row.effectiveTo === null) ?? detail.compensations[0];
  const currency = detail.employer?.currency ?? current?.currency ?? 'EUR';

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(createHrCompensationSchema),
    defaultValues: {
      effectiveFrom: todayIso(),
      payType: current?.payType ?? 'salary',
      amount: current ? Number(current.amount) : undefined,
      period: current?.period ?? 'month',
      hoursPerWeek: current?.hoursPerWeek ?? detail.profile?.nl.contractHoursPerWeek ?? detail.employee.weeklyHours ?? null,
      reason: null,
      allowRetroactive: false,
    },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: Parsed) {
    try {
      await create.mutateAsync({
        employeeId,
        effectiveFrom: values.effectiveFrom,
        payType: values.payType,
        amount: values.amount,
        period: values.period,
        currency,
        hoursPerWeek: values.hoursPerWeek ?? null,
        reason: values.reason ?? null,
        ...(values.allowRetroactive ? { allowRetroactive: true } : {}),
      });
      toast.success(t('weldhr.payroll.employee.compensation.saved'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.employee.compensation.saveFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.employee.compensation.addTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.employee.compensation.addDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                control={form.control}
                name="payType"
                label={t('weldhr.payroll.employee.compensation.payType')}
                options={[
                  { value: 'salary', label: t('weldhr.payroll.employee.compensation.salary') },
                  { value: 'hourly', label: t('weldhr.payroll.employee.compensation.hourly') },
                ]}
              />
              <TextField control={form.control} name="effectiveFrom" label={t('weldhr.payroll.employee.compensation.effectiveFrom')} type="date" emptyAs="string" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField control={form.control} name="amount" label={t('weldhr.payroll.employee.compensation.amount', { currency })} emptyAs="undefined" />
              <SelectField
                control={form.control}
                name="period"
                label={t('weldhr.payroll.employee.compensation.period')}
                options={(['hour', 'week', 'month', 'year'] as const).map((period) => ({ value: period, label: t(`weldhr.payroll.period.${period}`) }))}
              />
            </div>
            <NumberField control={form.control} name="hoursPerWeek" label={t('weldhr.payroll.employee.compensation.hoursPerWeek')} description={t('weldhr.payroll.employee.compensation.hoursPerWeekHint')} />
            <TextField control={form.control} name="reason" label={t('weldhr.payroll.employee.compensation.reason')} maxLength={1000} />
            <SwitchField
              control={form.control}
              name="allowRetroactive"
              label={t('weldhr.payroll.employee.compensation.allowRetroactive')}
              description={t('weldhr.payroll.employee.compensation.allowRetroactiveHint')}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
