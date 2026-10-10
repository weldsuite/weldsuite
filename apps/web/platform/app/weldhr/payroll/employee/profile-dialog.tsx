/**
 * Put an employee on payroll, or change how they are paid: which employer and
 * schedule, employment status and dates, plus the country-specific profile
 * (NL: contract type, DGA, insurance, 30% ruling, name details; US: work and
 * residence state, FLSA status, exemptions).
 */

import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { SUPPORTED_STATES, stateModule } from '@weldsuite/payroll-domain/us/states';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { upsertHrPayrollProfileSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useHrPayrollEmployers, useHrPayrollSchedules, useUpsertHrPayrollProfile } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { NumberField, SelectField, SwitchField, TextField, TriStateField } from '../components/form-fields';
import { FormSection } from '../components/payroll-ui';

type Values = z.input<typeof upsertHrPayrollProfileSchema>;
type Parsed = z.output<typeof upsertHrPayrollProfileSchema>;

export function ProfileDialog({ employeeId, detail, onClose }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; onClose: () => void }>) {
  const t = useTranslations();
  const upsert = useUpsertHrPayrollProfile();
  const { data: employers } = useHrPayrollEmployers();
  const profile = detail.profile;

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(upsertHrPayrollProfileSchema),
    defaultValues: {
      employerId: profile?.employerId ?? '',
      payScheduleId: profile?.payScheduleId ?? null,
      status: profile?.status ?? 'active',
      startDate: profile?.startDate ?? detail.employee.startDate ?? todayIso(),
      endDate: profile?.endDate ?? detail.employee.endDate ?? null,
      nl: {
        writtenContract: profile?.nl.writtenContract ?? true,
        indefiniteContract: profile?.nl.indefiniteContract ?? true,
        onCall: profile?.nl.onCall ?? false,
        isDga: profile?.nl.isDga ?? false,
        insuredWw: profile?.nl.insuredWw ?? null,
        insuredZw: profile?.nl.insuredZw ?? null,
        insuredWao: profile?.nl.insuredWao ?? null,
        contractHoursPerWeek: profile?.nl.contractHoursPerWeek ?? detail.employee.weeklyHours,
        expatRuling: profile?.nl.expatRuling ?? null,
        surnamePrefix: profile?.nl.surnamePrefix ?? null,
        initials: profile?.nl.initials ?? null,
        // 0 (unknown) is the same as not set.
        gender: profile?.nl.gender ? profile.nl.gender : null,
        nationality: profile?.nl.nationality ?? 'NL',
      },
      us: {
        workState: profile?.us.workState ?? null,
        residenceState: profile?.us.residenceState ?? null,
        flsaStatus: profile?.us.flsaStatus ?? 'nonexempt',
        statutoryEmployee: profile?.us.statutoryEmployee ?? false,
        retirementPlan: profile?.us.retirementPlan ?? false,
        exemptFica: profile?.us.exemptFica ?? false,
        exemptFuta: profile?.us.exemptFuta ?? false,
      },
    },
  });
  const employerId = useWatch({ control: form.control, name: 'employerId' });
  const expat = useWatch({ control: form.control, name: 'nl.expatRuling' });
  const employer = (employers ?? []).find((candidate) => candidate.id === employerId);
  const country = employer?.country ?? detail.employer?.country ?? null;
  const { data: schedules } = useHrPayrollSchedules({ employerId }, { enabled: Boolean(employerId) });
  const failure = form.formState.errors.root?.message ?? null;

  // With a single employer there is nothing to choose.
  useEffect(() => {
    if (!form.getValues('employerId') && employers?.length === 1) form.setValue('employerId', employers[0].id);
  }, [employers, form]);

  // A schedule belongs to one employer.
  useEffect(() => {
    const current = form.getValues('payScheduleId');
    if (current && schedules && !schedules.some((schedule) => schedule.id === current)) form.setValue('payScheduleId', null);
  }, [schedules, form]);

  async function onSubmit(values: Parsed) {
    try {
      await upsert.mutateAsync({
        employeeId,
        employerId: values.employerId,
        payScheduleId: values.payScheduleId ?? null,
        status: values.status,
        startDate: values.startDate ?? null,
        endDate: values.endDate ?? null,
        ...(country === 'NL' ? { nl: values.nl } : {}),
        ...(country === 'US' ? { us: values.us } : {}),
      });
      toast.success(t('weldhr.payroll.employee.profile.saved'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.employee.profile.saveFailed')) });
    }
  }

  const employerOptions = (employers ?? []).filter((candidate) => candidate.isActive || candidate.id === profile?.employerId).map((candidate) => ({ value: candidate.id, label: `${candidate.name} (${candidate.country})` }));
  const scheduleOptions = (schedules ?? []).filter((schedule) => schedule.isActive || schedule.id === profile?.payScheduleId).map((schedule) => ({ value: schedule.id, label: schedule.name }));

  return (
    <Dialog open onOpenChange={(open) => !open && !upsert.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{profile ? t('weldhr.payroll.employee.profile.editTitle') : t('weldhr.payroll.employee.profile.createTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.employee.profile.dialogDescription', { name: detail.employee.displayName })}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            <FormSection title={t('weldhr.payroll.employee.profile.sections.employment')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField control={form.control} name="employerId" label={t('weldhr.payroll.common.employer')} options={employerOptions} placeholder={t('weldhr.payroll.runs.start.employerPlaceholder')} />
                <SelectField control={form.control} name="payScheduleId" label={t('weldhr.payroll.common.schedule')} options={scheduleOptions} emptyLabel={t('weldhr.payroll.employee.profile.noSchedule')} disabled={!employerId} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <SelectField
                  control={form.control}
                  name="status"
                  label={t('weldhr.payroll.common.status')}
                  options={(['active', 'paused', 'ended'] as const).map((status) => ({ value: status, label: t(`weldhr.payroll.employee.profile.statuses.${status}`) }))}
                />
                <TextField control={form.control} name="startDate" label={t('weldhr.payroll.employee.profile.startDate')} type="date" />
                <TextField control={form.control} name="endDate" label={t('weldhr.payroll.employee.profile.endDate')} type="date" />
              </div>
            </FormSection>

            {country === 'NL' && (
              <>
                <FormSection title={t('weldhr.payroll.employee.profile.sections.nlContract')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwitchField control={form.control} name="nl.writtenContract" label={t('weldhr.payroll.employee.profile.nl.writtenContract')} />
                    <SwitchField control={form.control} name="nl.indefiniteContract" label={t('weldhr.payroll.employee.profile.nl.indefiniteContract')} />
                    <SwitchField control={form.control} name="nl.onCall" label={t('weldhr.payroll.employee.profile.nl.onCall')} description={t('weldhr.payroll.employee.profile.nl.onCallHint')} />
                    <SwitchField control={form.control} name="nl.isDga" label={t('weldhr.payroll.employee.profile.nl.isDga')} description={t('weldhr.payroll.employee.profile.nl.isDgaHint')} />
                  </div>
                  <NumberField control={form.control} name="nl.contractHoursPerWeek" label={t('weldhr.payroll.employee.profile.nl.contractHours')} />
                </FormSection>

                <FormSection title={t('weldhr.payroll.employee.profile.sections.nlInsurance')} description={t('weldhr.payroll.employee.profile.nl.insuranceHint')}>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(['insuredWw', 'insuredZw', 'insuredWao'] as const).map((key) => (
                      <TriStateField
                        key={key}
                        control={form.control}
                        name={`nl.${key}`}
                        label={t(`weldhr.payroll.employee.profile.nl.${key}`)}
                        defaultLabel={t('weldhr.payroll.employee.profile.nl.insuranceAuto')}
                        yesLabel={t('weldhr.common.yes')}
                        noLabel={t('weldhr.common.no')}
                      />
                    ))}
                  </div>
                </FormSection>

                <FormSection title={t('weldhr.payroll.employee.profile.sections.nlRuling')}>
                  <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <div>
                      <p className="text-sm font-medium">{t('weldhr.payroll.employee.profile.nl.expatRuling')}</p>
                      <p className="text-sm text-muted-foreground">{t('weldhr.payroll.employee.profile.nl.expatRulingHint')}</p>
                    </div>
                    <Switch
                      checked={expat !== null && expat !== undefined}
                      onCheckedChange={(checked) => form.setValue('nl.expatRuling', checked ? { from: todayIso(), to: null, percent: 30 } : null, { shouldDirty: true })}
                      aria-label={t('weldhr.payroll.employee.profile.nl.expatRuling')}
                    />
                  </div>
                  {expat && (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <TextField control={form.control} name="nl.expatRuling.from" label={t('weldhr.payroll.employee.profile.nl.rulingFrom')} type="date" emptyAs="string" />
                      <TextField control={form.control} name="nl.expatRuling.to" label={t('weldhr.payroll.employee.profile.nl.rulingTo')} type="date" />
                      <NumberField control={form.control} name="nl.expatRuling.percent" label={t('weldhr.payroll.employee.profile.nl.rulingPercent')} emptyAs="undefined" />
                    </div>
                  )}
                </FormSection>

                <FormSection title={t('weldhr.payroll.employee.profile.sections.nlName')} description={t('weldhr.payroll.employee.profile.nl.nameHint')}>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <TextField control={form.control} name="nl.initials" label={t('weldhr.payroll.employee.profile.nl.initials')} maxLength={20} />
                    <TextField control={form.control} name="nl.surnamePrefix" label={t('weldhr.payroll.employee.profile.nl.surnamePrefix')} maxLength={20} />
                    <SelectField
                      control={form.control}
                      name="nl.gender"
                      label={t('weldhr.payroll.employee.profile.nl.gender')}
                      numeric
                      emptyLabel={t('weldhr.payroll.employee.profile.nl.genderUnknown')}
                      options={[
                        { value: '1', label: t('weldhr.payroll.employee.profile.nl.genderMale') },
                        { value: '2', label: t('weldhr.payroll.employee.profile.nl.genderFemale') },
                      ]}
                    />
                    <TextField control={form.control} name="nl.nationality" label={t('weldhr.payroll.employee.profile.nl.nationality')} placeholder="NL" maxLength={2} uppercase />
                  </div>
                </FormSection>
              </>
            )}

            {country === 'US' && (
              <FormSection title={t('weldhr.payroll.employee.profile.sections.us')}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <StateField control={form.control} name="us.workState" label={t('weldhr.payroll.employee.profile.us.workState')} description={t('weldhr.payroll.employee.profile.us.workStateHint')} />
                  <StateField control={form.control} name="us.residenceState" label={t('weldhr.payroll.employee.profile.us.residenceState')} />
                  <SelectField
                    control={form.control}
                    name="us.flsaStatus"
                    label={t('weldhr.payroll.employee.profile.us.flsaStatus')}
                    options={[
                      { value: 'nonexempt', label: t('weldhr.payroll.employee.profile.us.nonexempt') },
                      { value: 'exempt', label: t('weldhr.payroll.employee.profile.us.exempt') },
                    ]}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SwitchField control={form.control} name="us.statutoryEmployee" label={t('weldhr.payroll.employee.profile.us.statutoryEmployee')} description={t('weldhr.payroll.employee.profile.us.statutoryEmployeeHint')} />
                  <SwitchField control={form.control} name="us.retirementPlan" label={t('weldhr.payroll.employee.profile.us.retirementPlan')} description={t('weldhr.payroll.employee.profile.us.retirementPlanHint')} />
                  <SwitchField control={form.control} name="us.exemptFica" label={t('weldhr.payroll.employee.profile.us.exemptFica')} />
                  <SwitchField control={form.control} name="us.exemptFuta" label={t('weldhr.payroll.employee.profile.us.exemptFuta')} />
                </div>
              </FormSection>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={upsert.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={upsert.isPending}>
                {upsert.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A US state: a select of the states WeldSuite can run payroll for, or a
 * two-letter input while that list is still empty (the state modules are
 * filled in by the engine). A state already saved that is not in the list
 * stays selectable so an old value is never dropped silently.
 */
function StateField({
  control,
  name,
  label,
  description,
}: Readonly<{ control: ReturnType<typeof useForm<Values>>['control']; name: 'us.workState' | 'us.residenceState'; label: string; description?: string }>) {
  const t = useTranslations();
  const current = useWatch({ control, name });

  if (SUPPORTED_STATES.length === 0) {
    return <TextField control={control} name={name} label={label} description={description} placeholder="CA" maxLength={2} uppercase />;
  }
  const codes = current && !SUPPORTED_STATES.includes(current) ? [current, ...SUPPORTED_STATES] : [...SUPPORTED_STATES];
  return (
    <SelectField
      control={control}
      name={name}
      label={label}
      description={description}
      emptyLabel={name === 'us.residenceState' ? t('weldhr.payroll.employee.profile.us.sameAsWork') : undefined}
      options={codes.map((code) => ({ value: code, label: stateModule(code)?.name ? `${code} · ${stateModule(code)?.name}` : code }))}
    />
  );
}
