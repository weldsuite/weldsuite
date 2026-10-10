/**
 * Create or edit a payroll employer: the legal entity that pays the salaries.
 * Netherlands: loonheffingennummer, sector, per-year Whk and Aof, holiday
 * allowance, payslip language. United States: EIN, deposit schedule, workweek,
 * and per-state account numbers with the SUI rate of each year.
 */

import { useState } from 'react';
import { useForm, useWatch, type Resolver, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { useTranslations } from '@weldsuite/i18n/client';
import { SUPPORTED_STATES, stateModule } from '@weldsuite/payroll-domain/us/states';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrPayrollEmployerSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useAccountingEntities } from '@/hooks/use-current-entity-currency';
import { useCreateHrPayrollEmployer, useUpdateHrPayrollEmployer } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { currentYear, humanizeKey } from '../lib/format';
import { NumberField, PlainNumberField, PlainTriStateField, SelectField, SwitchField, TextField } from './form-fields';
import { FormSection } from './payroll-ui';

type Values = z.input<typeof createHrPayrollEmployerSchema>;
type Parsed = z.output<typeof createHrPayrollEmployerSchema>;

/**
 * A cleared rate input leaves a key with no value in the per-year rate
 * records, which the schema rejects (a record's values are numbers). Drop
 * those keys before validating, so an empty rate means "not entered".
 */
function withoutEmptyRates(values: Values): Values {
  const states = values.usSettings?.states;
  if (!states) return values;
  const cleaned = Object.fromEntries(
    Object.entries(states).map(([code, state]) => {
      const suiRates = Object.fromEntries(Object.entries(state.suiRates ?? {}).filter(([, rate]) => rate !== undefined && rate !== null));
      const extraRates = Object.fromEntries(
        Object.entries(state.extraRates ?? {}).map(([year, rates]) => [year, Object.fromEntries(Object.entries(rates).filter(([, rate]) => rate !== undefined && rate !== null))]),
      );
      return [code, { ...state, suiRates, extraRates }];
    }),
  );
  return { ...values, usSettings: { ...values.usSettings, states: cleaned } };
}

const employerResolver = zodResolver(createHrPayrollEmployerSchema);
const resolver: Resolver<Values, unknown, Parsed> = (values, context, options) => employerResolver(withoutEmptyRates(values), context, options);

export function EmployerDialog({ employer, onClose }: Readonly<{ employer?: HrPayrollEmployer; onClose: () => void }>) {
  const t = useTranslations();
  const createEmployer = useCreateHrPayrollEmployer();
  const updateEmployer = useUpdateHrPayrollEmployer();
  const { data: entities } = useAccountingEntities();
  const saving = createEmployer.isPending || updateEmployer.isPending;

  const form = useForm<Values, unknown, Parsed>({
    resolver,
    defaultValues: {
      name: employer?.name ?? '',
      legalName: employer?.legalName ?? '',
      country: employer?.country ?? 'NL',
      accountingEntityId: employer?.accountingEntityId ?? null,
      address: employer?.address ?? {},
      nlSettings: employer?.nlSettings ?? {},
      usSettings: employer?.usSettings ?? {},
      requireSeparateApprover: employer?.requireSeparateApprover ?? false,
    },
  });
  const country = useWatch({ control: form.control, name: 'country' });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: Parsed) {
    // Only the settings of the employer's own country are sent.
    const base = {
      name: values.name,
      legalName: values.legalName,
      accountingEntityId: values.accountingEntityId ?? null,
      address: values.address,
      requireSeparateApprover: values.requireSeparateApprover,
      ...(values.country === 'NL' ? { nlSettings: values.nlSettings } : { usSettings: values.usSettings }),
    };
    try {
      if (employer) await updateEmployer.mutateAsync({ id: employer.id, ...base });
      else await createEmployer.mutateAsync({ ...base, country: values.country });
      toast.success(employer ? t('weldhr.payroll.settings.employers.updated') : t('weldhr.payroll.settings.employers.created'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.settings.employers.saveFailed')) });
    }
  }

  const entityOptions = (entities ?? []).map((entity) => ({ value: entity.id, label: entity.name ?? entity.id }));

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{employer ? t('weldhr.payroll.settings.employers.editTitle') : t('weldhr.payroll.settings.employers.createTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.settings.employers.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            <FormSection title={t('weldhr.payroll.settings.employers.sections.general')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField control={form.control} name="name" label={t('weldhr.payroll.settings.employers.name')} emptyAs="string" maxLength={160} />
                <TextField control={form.control} name="legalName" label={t('weldhr.payroll.settings.employers.legalName')} emptyAs="string" maxLength={255} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  control={form.control}
                  name="country"
                  label={t('weldhr.payroll.common.country')}
                  disabled={Boolean(employer)}
                  options={[
                    { value: 'NL', label: t('weldhr.payroll.country.NL') },
                    { value: 'US', label: t('weldhr.payroll.country.US') },
                  ]}
                  description={employer ? t('weldhr.payroll.settings.employers.countryLocked') : undefined}
                />
                <SelectField
                  control={form.control}
                  name="accountingEntityId"
                  label={t('weldhr.payroll.settings.employers.accountingEntity')}
                  options={entityOptions}
                  emptyLabel={t('weldhr.payroll.settings.employers.notLinked')}
                  description={t('weldhr.payroll.settings.employers.accountingEntityHint')}
                />
              </div>
              <SwitchField
                control={form.control}
                name="requireSeparateApprover"
                label={t('weldhr.payroll.settings.employers.fourEyes')}
                description={t('weldhr.payroll.settings.employers.fourEyesHint')}
              />
            </FormSection>

            <FormSection title={t('weldhr.payroll.settings.employers.sections.address')}>
              {country === 'NL' ? (
                <div className="grid gap-3 sm:grid-cols-6">
                  <TextField control={form.control} name="address.line1" label={t('weldhr.payroll.settings.employers.street')} className="sm:col-span-3" maxLength={255} />
                  <TextField control={form.control} name="address.houseNumber" label={t('weldhr.payroll.settings.employers.houseNumber')} className="sm:col-span-1" maxLength={20} />
                  <TextField control={form.control} name="address.houseNumberAddition" label={t('weldhr.payroll.settings.employers.houseNumberAddition')} className="sm:col-span-2" maxLength={20} />
                  <TextField control={form.control} name="address.postalCode" label={t('weldhr.payroll.settings.employers.postalCode')} className="sm:col-span-2" maxLength={20} />
                  <TextField control={form.control} name="address.city" label={t('weldhr.payroll.settings.employers.city')} className="sm:col-span-4" maxLength={120} />
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-6">
                  <TextField control={form.control} name="address.line1" label={t('weldhr.payroll.settings.employers.addressLine1')} className="sm:col-span-3" maxLength={255} />
                  <TextField control={form.control} name="address.line2" label={t('weldhr.payroll.settings.employers.addressLine2')} className="sm:col-span-3" maxLength={255} />
                  <TextField control={form.control} name="address.city" label={t('weldhr.payroll.settings.employers.city')} className="sm:col-span-3" maxLength={120} />
                  <TextField control={form.control} name="address.region" label={t('weldhr.payroll.settings.employers.state')} className="sm:col-span-1" maxLength={120} />
                  <TextField control={form.control} name="address.postalCode" label={t('weldhr.payroll.settings.employers.zip')} className="sm:col-span-2" maxLength={20} />
                </div>
              )}
            </FormSection>

            {country === 'NL' ? <NlSettings form={form} /> : <UsSettings form={form} />}

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

/** The tax years the per-year rates are entered for: this year and the next (provisional until published). */
function rateYears(): number[] {
  const year = currentYear();
  return [year, year + 1];
}

// ---------------------------------------------------------------------------
// Netherlands
// ---------------------------------------------------------------------------

type EmployerForm = UseFormReturn<Values, unknown, Parsed>;

/**
 * The records keyed by year (`nlSettings.years`, a state's `suiRates` and
 * `extraRates`) are edited as whole objects with `setValue`, not through
 * field paths: React Hook Form turns a numeric path segment such as
 * `years.2026` into an array index, which would make `years` an array.
 */
function NlSettings({ form }: Readonly<{ form: EmployerForm }>) {
  const t = useTranslations();
  const { control } = form;
  const years = useWatch({ control, name: 'nlSettings.years' }) ?? {};

  function patchYear(year: number, change: { whkRate?: number | null; aofSmallEmployer?: boolean | null }) {
    const key = String(year);
    form.setValue('nlSettings.years', { ...years, [key]: { ...years[key], ...change } }, { shouldDirty: true });
  }

  return (
    <>
      <FormSection title={t('weldhr.payroll.settings.employers.sections.nl')} description={t('weldhr.payroll.settings.employers.nlDescription')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            control={control}
            name="nlSettings.loonheffingennummer"
            label={t('weldhr.payroll.settings.employers.loonheffingennummer')}
            placeholder="123456789L01"
            description={t('weldhr.payroll.settings.employers.loonheffingennummerHint')}
            maxLength={12}
          />
          <NumberField control={control} name="nlSettings.sectorCode" label={t('weldhr.payroll.settings.employers.sectorCode')} description={t('weldhr.payroll.settings.employers.sectorCodeHint')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField control={control} name="nlSettings.holidayAllowancePercent" label={t('weldhr.payroll.settings.employers.holidayAllowancePercent')} placeholder="8" />
          <SelectField
            control={control}
            name="nlSettings.holidayAllowancePayoutMonth"
            label={t('weldhr.payroll.settings.employers.holidayAllowanceMonth')}
            numeric
            emptyLabel={t('weldhr.payroll.settings.employers.withEveryPayslip')}
            options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: t(`weldhr.payroll.months.${i + 1}`) }))}
          />
          <SelectField
            control={control}
            name="nlSettings.payslipLanguage"
            label={t('weldhr.payroll.settings.employers.payslipLanguage')}
            options={[
              { value: 'nl', label: 'Nederlands' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField control={control} name="nlSettings.contactName" label={t('weldhr.payroll.settings.employers.contactName')} maxLength={120} />
          <TextField control={control} name="nlSettings.contactPhone" label={t('weldhr.payroll.settings.employers.contactPhone')} maxLength={40} />
        </div>
      </FormSection>

      <FormSection title={t('weldhr.payroll.settings.employers.sections.nlRates')} description={t('weldhr.payroll.settings.employers.nlRatesDescription')}>
        {rateYears().map((year) => (
          <div key={year} className="grid items-end gap-3 sm:grid-cols-[4rem_1fr_1fr]">
            <p className="pb-2 text-sm font-medium tabular-nums">{year}</p>
            <PlainNumberField
              label={t('weldhr.payroll.settings.employers.whkRate')}
              value={years[String(year)]?.whkRate}
              min={0}
              max={100}
              onChange={(whkRate) => patchYear(year, { whkRate })}
            />
            <PlainTriStateField
              label={t('weldhr.payroll.settings.employers.aofSmall')}
              value={years[String(year)]?.aofSmallEmployer}
              onChange={(aofSmallEmployer) => patchYear(year, { aofSmallEmployer })}
              defaultLabel={t('weldhr.payroll.settings.employers.aofAuto')}
              yesLabel={t('weldhr.payroll.settings.employers.aofLow')}
              noLabel={t('weldhr.payroll.settings.employers.aofHigh')}
            />
          </div>
        ))}
      </FormSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// United States
// ---------------------------------------------------------------------------

type StatesMap = NonNullable<NonNullable<Values['usSettings']>['states']>;
type StateSettings = StatesMap[string];

function UsSettings({ form }: Readonly<{ form: EmployerForm }>) {
  const t = useTranslations();
  const { control } = form;
  return (
    <>
      <FormSection title={t('weldhr.payroll.settings.employers.sections.us')} description={t('weldhr.payroll.settings.employers.usDescription')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField control={control} name="usSettings.ein" label={t('weldhr.payroll.settings.employers.ein')} placeholder="12-3456789" maxLength={10} />
          <NumberField control={control} name="usSettings.employeeCountEstimate" label={t('weldhr.payroll.settings.employers.employeeCountEstimate')} description={t('weldhr.payroll.settings.employers.employeeCountEstimateHint')} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            control={control}
            name="usSettings.depositSchedule"
            label={t('weldhr.payroll.settings.employers.depositSchedule')}
            emptyLabel={t('weldhr.payroll.settings.employers.depositAuto')}
            options={[
              { value: 'monthly', label: t('weldhr.payroll.settings.employers.depositMonthly') },
              { value: 'semiweekly', label: t('weldhr.payroll.settings.employers.depositSemiweekly') },
            ]}
          />
          <SelectField
            control={control}
            name="usSettings.workweekStartDay"
            label={t('weldhr.payroll.settings.employers.workweekStart')}
            numeric
            emptyLabel={t('weldhr.payroll.settings.employers.workweekDefault')}
            options={Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: t(`weldhr.payroll.weekdays.${i}`) }))}
          />
        </div>
      </FormSection>
      <UsStatesEditor form={form} />
    </>
  );
}

function UsStatesEditor({ form }: Readonly<{ form: EmployerForm }>) {
  const t = useTranslations();
  const states: StatesMap = useWatch({ control: form.control, name: 'usSettings.states' }) ?? {};
  const [draft, setDraft] = useState('');
  const codes = Object.keys(states).sort();
  const available = SUPPORTED_STATES.filter((code) => !codes.includes(code));
  const years = rateYears();
  const extraYear = String(years[0]);

  function setStates(next: StatesMap) {
    form.setValue('usSettings.states', next, { shouldDirty: true });
  }

  function patchState(code: string, change: Partial<StateSettings>) {
    setStates({ ...states, [code]: { ...states[code], ...change } });
  }

  function add(code: string) {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized) || codes.includes(normalized)) return;
    setStates({ ...states, [normalized]: {} });
    setDraft('');
  }

  function remove(code: string) {
    setStates(Object.fromEntries(Object.entries(states).filter(([key]) => key !== code)));
  }

  return (
    <FormSection title={t('weldhr.payroll.settings.employers.sections.usStates')} description={t('weldhr.payroll.settings.employers.usStatesDescription')}>
      {codes.length === 0 && <p className="text-sm text-muted-foreground">{t('weldhr.payroll.settings.employers.noStates')}</p>}

      {codes.map((code) => {
        const state = states[code] ?? {};
        const extra = state.extraRates?.[extraYear] ?? {};
        return (
          <div key={code} className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {code}
                {stateModule(code)?.name && <span className="font-normal text-muted-foreground"> · {stateModule(code)?.name}</span>}
              </p>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.payroll.settings.employers.removeState', { state: code })} onClick={() => remove(code)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField control={form.control} name={`usSettings.states.${code}.withholdingAccountNumber`} label={t('weldhr.payroll.settings.employers.withholdingAccount')} maxLength={60} />
              <TextField control={form.control} name={`usSettings.states.${code}.suiAccountNumber`} label={t('weldhr.payroll.settings.employers.suiAccount')} maxLength={60} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {years.map((year) => (
                <PlainNumberField
                  key={year}
                  label={t('weldhr.payroll.settings.employers.suiRate', { year })}
                  value={state.suiRates?.[String(year)]}
                  min={0}
                  max={100}
                  onChange={(rate) => patchState(code, { suiRates: withRate(state.suiRates, String(year), rate) })}
                />
              ))}
            </div>
            {Object.keys(extra).length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.keys(extra).map((rateCode) => (
                  <PlainNumberField
                    key={rateCode}
                    label={`${humanizeKey(rateCode)} (${extraYear})`}
                    value={extra[rateCode]}
                    min={0}
                    max={100}
                    onChange={(rate) => patchState(code, { extraRates: { ...state.extraRates, [extraYear]: withRate(extra, rateCode, rate) } })}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        {available.length > 0 ? (
          available.map((code) => (
            <Button key={code} type="button" size="sm" variant="outline" onClick={() => add(code)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {code}
            </Button>
          ))
        ) : (
          <>
            <Input value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase())} maxLength={2} className="w-20" placeholder="CA" aria-label={t('weldhr.payroll.settings.employers.stateCode')} />
            <Button type="button" size="sm" variant="outline" onClick={() => add(draft)} disabled={!/^[A-Za-z]{2}$/.test(draft)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('weldhr.payroll.settings.employers.addState')}
            </Button>
          </>
        )}
      </div>
    </FormSection>
  );
}

/** A rate record with one key set, or removed when the input is blank. */
function withRate(rates: Record<string, number> | undefined, key: string, rate: number | null | undefined): Record<string, number> {
  const next = { ...rates };
  if (rate === null || rate === undefined) delete next[key];
  else next[key] = rate;
  return next;
}
