import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCreateSalesTaxAgency, useSalesTaxAgencies } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { FILING_FREQUENCIES } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { defaultAgencyName, getSalesTaxState, salesTaxStates } from '@/lib/weldbooks/us-sales-tax-states';
import { Field, describedBy } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  NEW_AGENCY_STATUSES,
  cashBasisAvailable,
  emptyAgencyForm,
  makeAgencySchema,
  stateHasLocalAgencies,
  toCreateAgencyInput,
  withLocal,
  withStateDefaults,
  type AgencyFormValues,
} from './agency-model';
import { StateInfoPanel } from './state-info-panel';

export interface AgencyWizardProps {
  /** A state to start with (the nexus monitor links here with `?state=`). */
  initialStateCode?: string;
}

/** The registration wizard: pick the state, then say how you are registered there. */
export function AgencyWizard({ initialStateCode }: Readonly<AgencyWizardProps>) {
  const { t, format, plural } = useSetupTexts();
  const tw = t.wizard;
  const navigate = useNavigate();
  const agencies = useSalesTaxAgencies();
  const create = useCreateSalesTaxAgency();

  const prefill = initialStateCode && getSalesTaxState(initialStateCode) && salesTaxStates().some((s) => s.code === initialStateCode.toUpperCase())
    ? initialStateCode.toUpperCase()
    : '';
  const [step, setStep] = useState<0 | 1>(prefill ? 1 : 0);
  const schema = useMemo(() => makeAgencySchema(t.validation), [t.validation]);
  const form = useForm<AgencyFormValues>({ resolver: zodResolver(schema), defaultValues: emptyAgencyForm(prefill) });
  const values = form.watch();
  const errors = form.formState.errors;

  const state = getSalesTaxState(values.stateCode);
  const hasLocal = stateHasLocalAgencies(state);
  // A state has one state-level agency per entity, whatever its status.
  const addedStates = useMemo(
    () => new Set((agencies.data ?? []).filter((a) => a.level === 'state').map((a) => a.stateCode)),
    [agencies.data],
  );
  const stateAdded = !!state && !values.local && addedStates.has(state.code);
  const cashOffered = cashBasisAvailable(state, values.local);
  const monitoring = values.status === 'monitoring';

  const goNext = async () => {
    const valid = await form.trigger(['stateCode', 'name', 'localJurisdictionCode']);
    if (valid && !stateAdded) setStep(1);
  };

  const submit = form.handleSubmit(async (data) => {
    try {
      const created = await create.mutateAsync(toCreateAgencyInput(data));
      toast.success(format(tw.success, { state: state?.name ?? data.stateCode }), {
        description: [
          created.accountsCreated > 0 ? plural(created.accountsCreated, tw.successAccounts) : null,
          created.rulesSeeded > 0 ? plural(created.rulesSeeded, tw.successRules) : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
      void navigate({ to: '/weldbooks/sales-tax/agencies/$id', params: { id: created.id } });
    } catch {
      // The error shows under the form (create.error).
    }
  });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/weldbooks/sales-tax/agencies">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {tw.back}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{tw.title}</h1>
        <p className="text-sm text-muted-foreground">{tw.subtitle}</p>
      </div>

      <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label={tw.title}>
        {([tw.steps.state, tw.steps.registration] as const).map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? 'step' : undefined}
            className={
              step === index
                ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                : 'rounded-full border px-3 py-1 text-muted-foreground'
            }
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form onSubmit={submit} noValidate className="space-y-6">
          {step === 0 ? (
            <Card>
              <CardContent className="space-y-5 pt-6">
                <Field label={tw.stateStep.label} htmlFor="agency-state" error={errors.stateCode?.message}>
                  <Controller
                    control={form.control}
                    name="stateCode"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(code) => {
                          form.reset(withStateDefaults(form.getValues(), code), { keepErrors: false });
                        }}
                      >
                        <SelectTrigger id="agency-state" aria-label={tw.stateStep.label} aria-invalid={!!errors.stateCode}>
                          <SelectValue placeholder={tw.stateStep.placeholder} />
                        </SelectTrigger>
                        <SelectContent>
                          {salesTaxStates().map((s) => (
                            <SelectItem key={s.code} value={s.code}>
                              {s.name} ({s.code}){addedStates.has(s.code) ? ` · ${tw.stateStep.alreadyAdded}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>

                {stateAdded ? (
                  <Alert role="status">
                    <AlertDescription>{tw.duplicate}</AlertDescription>
                  </Alert>
                ) : null}

                {state && hasLocal ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="agency-local"
                        checked={values.local}
                        onCheckedChange={(checked) => form.reset(withLocal(form.getValues(), checked === true))}
                      />
                      <Label htmlFor="agency-local" className="font-normal leading-snug">
                        {tw.stateStep.local}
                      </Label>
                    </div>
                    {values.local ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field
                          label={tw.stateStep.localName}
                          htmlFor="agency-local-name"
                          help={tw.stateStep.localNameHelp}
                          error={errors.name?.message}
                        >
                          <Input id="agency-local-name" {...form.register('name')} aria-invalid={!!errors.name} />
                        </Field>
                        <Field
                          label={tw.stateStep.localCode}
                          htmlFor="agency-local-code"
                          help={tw.stateStep.localCodeHelp}
                          error={errors.localJurisdictionCode?.message}
                        >
                          <Input
                            id="agency-local-code"
                            {...form.register('localJurisdictionCode')}
                            aria-invalid={!!errors.localJurisdictionCode}
                          />
                        </Field>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {!state ? <p className="text-sm text-muted-foreground">{tw.stateStep.pickState}</p> : null}

                <div className="flex justify-end">
                  <Button type="button" onClick={() => void goNext()} disabled={!state || stateAdded}>
                    {t.common.next}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="space-y-5 pt-6">
                {state ? (
                  <p className="text-sm">
                    <span className="font-medium">
                      {values.local ? values.name.trim() || state.name : state.name}
                    </span>
                    <Button type="button" variant="link" size="sm" className="ml-2 h-auto p-0" onClick={() => setStep(0)}>
                      {t.common.back}
                    </Button>
                  </p>
                ) : null}

                <Field label={tw.registrationStep.status} htmlFor="agency-status">
                  <Controller
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <RadioGroup id="agency-status" value={field.value} onValueChange={field.onChange} className="gap-3">
                        {NEW_AGENCY_STATUSES.map((status) => (
                          <div key={status} className="flex items-start gap-3 rounded-md border p-3">
                            <RadioGroupItem value={status} id={`agency-status-${status}`} className="mt-0.5" />
                            <Label htmlFor={`agency-status-${status}`} className="flex-1 cursor-pointer space-y-0.5 font-normal">
                              <span className="block font-medium">{t.statuses[status]}</span>
                              <span className="block text-xs text-muted-foreground">{tw.registrationStep.statusHelp[status]}</span>
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    )}
                  />
                </Field>

                {!monitoring ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        label={tw.registrationStep.registrationNumber}
                        htmlFor="agency-number"
                        error={errors.registrationNumber?.message}
                      >
                        <Input id="agency-number" {...form.register('registrationNumber')} autoComplete="off" />
                      </Field>
                      <Field
                        label={tw.registrationStep.registeredFrom}
                        htmlFor="agency-from"
                        help={tw.registrationStep.registeredFromHelp}
                        error={errors.registeredFrom?.message}
                      >
                        <Input
                          id="agency-from"
                          type="date"
                          required
                          {...form.register('registeredFrom')}
                          aria-invalid={!!errors.registeredFrom}
                          aria-describedby={describedBy('agency-from', { help: true, error: !!errors.registeredFrom })}
                        />
                      </Field>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        label={tw.registrationStep.frequency}
                        htmlFor="agency-frequency"
                        help={tw.registrationStep.frequencyHelp}
                      >
                        <Controller
                          control={form.control}
                          name="filingFrequency"
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger id="agency-frequency" aria-label={tw.registrationStep.frequency}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {FILING_FREQUENCIES.map((f) => (
                                  <SelectItem key={f} value={f}>
                                    {t.frequencies[f]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </Field>
                      <Field
                        label={tw.registrationStep.firstPeriodStart}
                        htmlFor="agency-first-period"
                        help={tw.registrationStep.firstPeriodStartHelp}
                        error={errors.firstPeriodStart?.message}
                      >
                        <Input id="agency-first-period" type="date" {...form.register('firstPeriodStart')} />
                      </Field>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        label={tw.registrationStep.dueDay}
                        htmlFor="agency-due-day"
                        help={tw.registrationStep.dueDayHelp}
                        error={errors.dueDay?.message}
                      >
                        <Input
                          id="agency-due-day"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={31}
                          {...form.register('dueDay')}
                          aria-invalid={!!errors.dueDay}
                        />
                      </Field>
                      <Field label={tw.registrationStep.basis} htmlFor="agency-basis" error={errors.reportingBasis?.message}>
                        {cashOffered ? (
                          <Controller
                            control={form.control}
                            name="reportingBasis"
                            render={({ field }) => (
                              <RadioGroup id="agency-basis" value={field.value} onValueChange={field.onChange} className="flex gap-6 pt-1">
                                {(['accrual', 'cash'] as const).map((basis) => (
                                  <div key={basis} className="flex items-center gap-2">
                                    <RadioGroupItem value={basis} id={`agency-basis-${basis}`} />
                                    <Label htmlFor={`agency-basis-${basis}`} className="font-normal">
                                      {t.bases[basis]}
                                    </Label>
                                  </div>
                                ))}
                              </RadioGroup>
                            )}
                          />
                        ) : (
                          <p id="agency-basis" className="pt-1 text-sm text-muted-foreground" data-testid="accrual-only-note">
                            {format(tw.registrationStep.basisAccrualOnly, { state: state?.name ?? '' })}
                          </p>
                        )}
                      </Field>
                    </div>

                    <div className="flex items-start gap-2">
                      <Controller
                        control={form.control}
                        name="sstMember"
                        render={({ field }) => (
                          <Checkbox id="agency-sst" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                        )}
                      />
                      <Label htmlFor="agency-sst" className="font-normal leading-snug">
                        {tw.registrationStep.sst}
                      </Label>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      {!values.local ? (
                        <Field
                          label={tw.registrationStep.name}
                          htmlFor="agency-name"
                          help={tw.registrationStep.nameHelp}
                          error={errors.name?.message}
                        >
                          <Input
                            id="agency-name"
                            placeholder={state ? defaultAgencyName(state) : ''}
                            {...form.register('name')}
                          />
                        </Field>
                      ) : null}
                      <Field
                        label={tw.registrationStep.portalUrl}
                        htmlFor="agency-portal"
                        error={errors.portalUrl?.message}
                      >
                        <Input id="agency-portal" type="url" inputMode="url" {...form.register('portalUrl')} aria-invalid={!!errors.portalUrl} />
                      </Field>
                    </div>
                  </>
                ) : null}

                <Field label={tw.registrationStep.notes} htmlFor="agency-notes" error={errors.notes?.message}>
                  <Textarea id="agency-notes" rows={3} {...form.register('notes')} />
                </Field>

                {create.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {create.error instanceof Error && create.error.message ? create.error.message : tw.saveError}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex flex-wrap justify-between gap-2">
                  <Button type="button" variant="outline" onClick={() => setStep(0)}>
                    {t.common.back}
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                    {create.isPending ? tw.registering : tw.register}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </form>

        {state ? <StateInfoPanel stateCode={state.code} className="h-fit lg:sticky lg:top-4" /> : null}
      </div>
    </div>
  );
}
