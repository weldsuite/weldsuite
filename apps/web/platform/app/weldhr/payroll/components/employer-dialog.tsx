/**
 * Create or edit a payroll employer: a payroll registration of a legal entity.
 * Netherlands: sector, per-year Whk and Aof, holiday allowance, payslip
 * language. United States: deposit schedule, workweek, and per-state account
 * numbers with the SUI rate of each year. The registration number
 * (loonheffingennummer, EIN) and the salary account are picked from the
 * entity's, or added.
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
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { SUPPORTED_STATES, stateModule } from '@weldsuite/payroll-domain/us/states';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrPayrollEmployerSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { normalizeRegistrationNumber, registrationNumberError } from '@weldsuite/app-api-client/schemas/legal-entities';
import { LegalEntityPicker } from '@/components/legal-entity/legal-entity-picker';
import { useLegalEntities, useLegalEntityBankAccounts, useLegalEntityRegistrations } from '@/hooks/queries/use-legal-entities-queries';
import { useRouter } from '@/lib/router';
import { useCreateHrPayrollEmployer, useUpdateHrPayrollEmployer } from '@/hooks/queries/use-weldhr-payroll-queries';
import { errorMessage } from '../../components/shared';
import { currentYear, humanizeKey } from '../lib/format';
import { NumberField, PlainNumberField, PlainTriStateField, SelectField, SwitchField, TextField } from './form-fields';
import { FormSection } from './payroll-ui';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';

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

/** The payroll registration of each country: loonheffingennummer (NL), EIN (US). */
const REGISTRATION_TYPE = { NL: 'nl_payroll_tax', US: 'ein' } as const;
const NEW_REGISTRATION = '__new';
const NO_BANK = '__none';

function isPayrollCountry(code: string | null | undefined): code is 'NL' | 'US' {
  return code === 'NL' || code === 'US';
}

/**
 * An employer is a payroll registration of a legal entity. Name, country,
 * currency and address come from the entity (Settings → Legal entities); here
 * you pick the entity, the registration payroll runs under (or type a new
 * number), the salary account and the payroll settings.
 */
export function EmployerDialog({ employer, onClose }: Readonly<{ employer?: HrPayrollEmployer; onClose: () => void }>) {
  const t = useTranslations();
  const router = useRouter();
  const createEmployer = useCreateHrPayrollEmployer();
  const updateEmployer = useUpdateHrPayrollEmployer();
  const saving = createEmployer.isPending || updateEmployer.isPending;

  const form = useForm<Values, unknown, Parsed>({
    resolver,
    defaultValues: {
      legalEntityId: employer?.legalEntityId ?? null,
      registrationId: employer?.registrationId ?? null,
      bankAccountId: employer?.bankAccountId ?? null,
      label: employer?.label ?? null,
      country: employer?.country ?? 'NL',
      nlSettings: employer?.nlSettings ?? {},
      usSettings: employer?.usSettings ?? {},
      requireSeparateApprover: employer?.requireSeparateApprover ?? false,
    },
  });
  const country = useWatch({ control: form.control, name: 'country' }) ?? 'NL';
  const legalEntityId = useWatch({ control: form.control, name: 'legalEntityId' });
  const bankAccountId = useWatch({ control: form.control, name: 'bankAccountId' });
  const failure = form.formState.errors.root?.message ?? null;

  // An existing registration, or a new number typed here.
  const [registrationChoice, setRegistrationChoice] = useState<string>(employer?.registrationId ?? NEW_REGISTRATION);
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  const { data: entities } = useLegalEntities({ app: 'weldhr' });
  const { data: registrations } = useLegalEntityRegistrations(legalEntityId);
  const { data: bankAccounts } = useLegalEntityBankAccounts(legalEntityId);
  const pickedEntity = entities?.find((e) => e.id === legalEntityId);
  const registrationType = isPayrollCountry(country) ? REGISTRATION_TYPE[country] : null;
  const registrationOptions = (registrations ?? []).filter((r) => r.type === registrationType);
  const bankOptions = (bankAccounts ?? []).filter((b) => b.isActive);
  const unsupportedCountry = Boolean(pickedEntity) && !isPayrollCountry(pickedEntity?.jurisdictionCode);

  function pickEntity(id: string) {
    const entity = entities?.find((e) => e.id === id);
    form.setValue('legalEntityId', id, { shouldDirty: true });
    form.clearErrors('legalEntityId');
    if (isPayrollCountry(entity?.jurisdictionCode)) form.setValue('country', entity.jurisdictionCode);
    form.setValue('registrationId', null);
    form.setValue('bankAccountId', null);
    setRegistrationChoice(NEW_REGISTRATION);
    setRegistrationNumber('');
    setRegistrationError(null);
  }

  async function onSubmit(values: Parsed) {
    if (!values.legalEntityId) {
      form.setError('legalEntityId', { message: t('weldhr.payroll.settings.employers.legalEntityRequired') });
      return;
    }
    // A new registration number is checked against the format of its type before it is created on the entity.
    let registration: { registrationId: string | null; registrationNumber?: string } = { registrationId: null };
    if (registrationChoice === NEW_REGISTRATION) {
      const typed = registrationNumber.trim();
      if (typed && registrationType) {
        const normalized = normalizeRegistrationNumber(registrationType, typed);
        const problem = registrationNumberError(registrationType, normalized);
        if (problem) {
          setRegistrationError(problem);
          return;
        }
        registration = { registrationId: null, registrationNumber: normalized };
      }
    } else {
      registration = { registrationId: registrationChoice };
    }
    setRegistrationError(null);

    // Only the settings of the employer's own country are sent.
    const base = {
      legalEntityId: values.legalEntityId,
      bankAccountId: values.bankAccountId ?? null,
      label: values.label ?? null,
      requireSeparateApprover: values.requireSeparateApprover,
      ...(country === 'NL' ? { nlSettings: values.nlSettings } : { usSettings: values.usSettings }),
    };
    try {
      if (employer) {
        // An edit picks an existing registration; a number typed here is only for creating one.
        await updateEmployer.mutateAsync({ id: employer.id, ...base, registrationId: registration.registrationId });
      } else {
        await createEmployer.mutateAsync({ ...base, ...registration, country });
      }
      toast.success(employer ? t('weldhr.payroll.settings.employers.updated') : t('weldhr.payroll.settings.employers.created'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.settings.employers.saveFailed')) });
    }
  }

  const entityLabel = employer?.legalEntityName ?? pickedEntity?.name ?? employer?.name;

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
              <div className="space-y-2">
                <Label htmlFor="employer-legal-entity">{t('weldhr.payroll.settings.employers.legalEntity')}</Label>
                {employer?.legalEntityId ? (
                  <p className="text-sm" data-testid="employer-legal-entity-locked">
                    {entityLabel}
                    <span className="block text-xs text-muted-foreground">{t('weldhr.payroll.settings.employers.legalEntityLocked')}</span>
                  </p>
                ) : (
                  <LegalEntityPicker id="employer-legal-entity" app="weldhr" value={legalEntityId} onChange={pickEntity} />
                )}
                <p className="text-xs text-muted-foreground">{t('weldhr.payroll.settings.employers.fromEntityNotice')}</p>
                {form.formState.errors.legalEntityId?.message && (
                  <p className="text-sm text-destructive">{form.formState.errors.legalEntityId.message}</p>
                )}
                {unsupportedCountry && (
                  <p className="text-sm text-destructive">{t('weldhr.payroll.settings.employers.unsupportedCountry')}</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="employer-registration">
                    {country === 'NL' ? t('weldhr.payroll.settings.employers.loonheffingennummer') : t('weldhr.payroll.settings.employers.ein')}
                  </Label>
                  <Select
                    value={registrationChoice}
                    onValueChange={(v) => {
                      setRegistrationChoice(v);
                      setRegistrationError(null);
                    }}
                    disabled={!legalEntityId}
                  >
                    <SelectTrigger id="employer-registration">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {registrationOptions.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.number}
                          {r.label ? <span className="ml-2 text-xs text-muted-foreground">{r.label}</span> : null}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_REGISTRATION}>{t('weldhr.payroll.settings.employers.registrationNew')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {registrationChoice === NEW_REGISTRATION && !employer && (
                    <Input
                      aria-label={t('weldhr.payroll.settings.employers.registrationNumber')}
                      value={registrationNumber}
                      onChange={(e) => setRegistrationNumber(e.target.value)}
                      placeholder={country === 'NL' ? '123456789L01' : '12-3456789'}
                      maxLength={20}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {country === 'NL' ? t('weldhr.payroll.settings.employers.loonheffingennummerHint') : t('weldhr.payroll.settings.employers.registrationHintUs')}
                  </p>
                  {registrationError && <p className="text-sm text-destructive">{registrationError}</p>}
                </div>

                <TextField
                  control={form.control}
                  name="label"
                  label={t('weldhr.payroll.settings.employers.label')}
                  description={t('weldhr.payroll.settings.employers.labelHint')}
                  maxLength={160}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="employer-bank-account">{t('weldhr.payroll.settings.employers.bankAccount')}</Label>
                <Select
                  value={bankAccountId ?? NO_BANK}
                  onValueChange={(v) => form.setValue('bankAccountId', v === NO_BANK ? null : v, { shouldDirty: true })}
                  disabled={!legalEntityId}
                >
                  <SelectTrigger id="employer-bank-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BANK}>{t('weldhr.payroll.settings.employers.bankNone')}</SelectItem>
                    {bankOptions.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                        <span className="ml-2 text-xs text-muted-foreground">{b.iban ?? (b.accountNumberLast4 ? `••••${b.accountNumberLast4}` : '')}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('weldhr.payroll.settings.employers.bankAccountHint')}</p>
              </div>

              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => router.push(legalEntityId ? `/settings/legal-entities/${legalEntityId}` : '/settings/legal-entities')}
              >
                {t('weldhr.payroll.settings.employers.manageEntity')}
              </button>

              <SwitchField
                control={form.control}
                name="requireSeparateApprover"
                label={t('weldhr.payroll.settings.employers.fourEyes')}
                description={t('weldhr.payroll.settings.employers.fourEyesHint')}
              />
            </FormSection>

            {country === 'NL' ? <NlSettings form={form} /> : <UsSettings form={form} />}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={saving || unsupportedCountry}>
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
