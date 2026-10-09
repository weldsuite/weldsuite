/**
 * Sign a tax form: the Dutch loonheffingskorting election, the US W-4 or a
 * state withholding certificate. The employee signs their own on My HR with a
 * typed full name; HR enters a paper form on the employee's Payroll tab (the
 * name is then the one on the paper form). The state certificate is rendered
 * from the state module's field list.
 */

import { useState } from 'react';
import { useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { stateModule } from '@weldsuite/payroll-domain/us/states';
import type { StateCertificateFieldDef } from '@weldsuite/payroll-domain/us/states';
import type { HrStateCertificateDefinition, HrTaxElectionKind } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import {
  hrNlLoonheffingskortingElectionSchema,
  hrUsStateCertificateElectionSchema,
  hrUsW4ElectionSchema,
  type CreateHrTaxElectionInput,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { currentYear } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';
import { NumberField, SelectField, SwitchField, TextField } from './form-fields';
import { InfoLine } from './payroll-ui';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const signature = z.string().trim().min(1, 'Required').max(255);

export interface TaxElectionTarget {
  kind: HrTaxElectionKind;
  state: string | null;
  /** The state's certificate as the API sends it (My HR); the state module is the fallback (HR). */
  certificate?: HrStateCertificateDefinition | null;
}

interface DialogProps {
  target: TaxElectionTarget;
  /** `self`: the employee signs; `hr`: HR enters a paper form. */
  mode: 'self' | 'hr';
  /** The employee's name, offered as the signature. */
  defaultName: string;
  onSubmit: (election: CreateHrTaxElectionInput) => Promise<void>;
  onClose: () => void;
}

export function TaxElectionDialog(props: Readonly<DialogProps>) {
  const t = useTranslations();
  const { target, mode, onClose } = props;
  const title = t(`weldhr.payroll.elections.titles.${target.kind}`, { state: target.state ?? '' });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{mode === 'self' ? t('weldhr.payroll.elections.selfDescription') : t('weldhr.payroll.elections.hrDescription')}</DialogDescription>
        </DialogHeader>
        {target.kind === 'nl_loonheffingskorting' && <NlForm {...props} />}
        {target.kind === 'us_w4' && <W4Form {...props} />}
        {target.kind === 'us_state_certificate' && <StateForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

/** Shared bottom of every election form: the signature, an explanation, and the buttons. */
function SignatureFooter({
  mode,
  saving,
  onClose,
}: Readonly<{
  mode: 'self' | 'hr';
  saving: boolean;
  onClose: () => void;
}>) {
  const t = useTranslations();
  // Rendered inside <Form>, so the form of whichever election dialog this is.
  const { control } = useFormContext<{ signatureName: string }>();
  return (
    <>
      <TextField
        control={control}
        name="signatureName"
        label={mode === 'self' ? t('weldhr.payroll.elections.signatureSelf') : t('weldhr.payroll.elections.signatureHr')}
        description={mode === 'self' ? t('weldhr.payroll.elections.signatureSelfHint') : t('weldhr.payroll.elections.signatureHrHint')}
        emptyAs="string"
        maxLength={255}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {t('weldhr.common.cancel')}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === 'self' ? t('weldhr.payroll.elections.sign') : t('weldhr.payroll.elections.record')}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Netherlands
// ---------------------------------------------------------------------------

const nlSchema = z.object({ effectiveFrom: isoDate, signatureName: signature, data: hrNlLoonheffingskortingElectionSchema });
type NlValues = z.input<typeof nlSchema>;

function NlForm({ mode, defaultName, onSubmit, onClose }: Readonly<DialogProps>) {
  const t = useTranslations();
  const [saving, setSaving] = useState(false);
  const form = useForm<NlValues, unknown, z.output<typeof nlSchema>>({
    resolver: zodResolver(nlSchema),
    defaultValues: { effectiveFrom: todayIso(), signatureName: defaultName, data: { applyCredit: true } },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function submit(values: z.output<typeof nlSchema>) {
    setSaving(true);
    try {
      await onSubmit({ kind: 'nl_loonheffingskorting', effectiveFrom: values.effectiveFrom, data: values.data, signatureName: values.signatureName });
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.elections.failed')) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <ErrorBanner error={failure} />
        <InfoLine>{t('weldhr.payroll.elections.nl.explanation')}</InfoLine>
        <SwitchField
          control={form.control}
          name="data.applyCredit"
          label={t('weldhr.payroll.elections.nl.applyCredit')}
          description={t('weldhr.payroll.elections.nl.applyCreditHint')}
        />
        <TextField control={form.control} name="effectiveFrom" label={t('weldhr.payroll.elections.effectiveFrom')} type="date" emptyAs="string" />
        <SignatureFooter mode={mode} saving={saving} onClose={onClose} />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// United States — W-4
// ---------------------------------------------------------------------------

const w4Schema = z.object({ effectiveFrom: isoDate, signatureName: signature, data: hrUsW4ElectionSchema });
type W4Values = z.input<typeof w4Schema>;

function W4Form({ mode, defaultName, onSubmit, onClose }: Readonly<DialogProps>) {
  const t = useTranslations();
  const [saving, setSaving] = useState(false);
  const form = useForm<W4Values, unknown, z.output<typeof w4Schema>>({
    resolver: zodResolver(w4Schema),
    defaultValues: {
      effectiveFrom: todayIso(),
      signatureName: defaultName,
      data: {
        formYear: currentYear(),
        filingStatus: 'single',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        exempt: false,
        allowances: null,
        nonresidentAlien: false,
      },
    },
  });
  const formYear = form.watch('data.formYear');
  const failure = form.formState.errors.root?.message ?? null;

  async function submit(values: z.output<typeof w4Schema>) {
    setSaving(true);
    try {
      await onSubmit({
        kind: 'us_w4',
        effectiveFrom: values.effectiveFrom,
        data: { ...values.data, allowances: values.data.formYear < 2020 ? (values.data.allowances ?? 0) : null },
        signatureName: values.signatureName,
      });
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.elections.failed')) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <ErrorBanner error={failure} />
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField control={form.control} name="data.formYear" label={t('weldhr.payroll.elections.w4.formYear')} description={t('weldhr.payroll.elections.w4.formYearHint')} emptyAs="undefined" />
          <SelectField
            control={form.control}
            name="data.filingStatus"
            label={t('weldhr.payroll.elections.w4.filingStatus')}
            options={[
              { value: 'single', label: t('weldhr.payroll.elections.w4.filingStatuses.single') },
              { value: 'married_jointly', label: t('weldhr.payroll.elections.w4.filingStatuses.married_jointly') },
              { value: 'head_of_household', label: t('weldhr.payroll.elections.w4.filingStatuses.head_of_household') },
            ]}
          />
        </div>
        <SwitchField control={form.control} name="data.multipleJobs" label={t('weldhr.payroll.elections.w4.multipleJobs')} description={t('weldhr.payroll.elections.w4.multipleJobsHint')} />
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField control={form.control} name="data.dependentsAmount" label={t('weldhr.payroll.elections.w4.dependentsAmount')} description={t('weldhr.payroll.elections.w4.dependentsAmountHint')} emptyAs="undefined" />
          <NumberField control={form.control} name="data.otherIncome" label={t('weldhr.payroll.elections.w4.otherIncome')} emptyAs="undefined" />
          <NumberField control={form.control} name="data.deductions" label={t('weldhr.payroll.elections.w4.deductions')} emptyAs="undefined" />
          <NumberField control={form.control} name="data.extraWithholding" label={t('weldhr.payroll.elections.w4.extraWithholding')} emptyAs="undefined" />
        </div>
        {formYear < 2020 && (
          <NumberField control={form.control} name="data.allowances" label={t('weldhr.payroll.elections.w4.allowances')} description={t('weldhr.payroll.elections.w4.allowancesHint')} />
        )}
        <SwitchField control={form.control} name="data.exempt" label={t('weldhr.payroll.elections.w4.exempt')} description={t('weldhr.payroll.elections.w4.exemptHint')} />
        <SwitchField control={form.control} name="data.nonresidentAlien" label={t('weldhr.payroll.elections.w4.nonresidentAlien')} />
        <TextField control={form.control} name="effectiveFrom" label={t('weldhr.payroll.elections.effectiveFrom')} type="date" emptyAs="string" />
        <SignatureFooter mode={mode} saving={saving} onClose={onClose} />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// United States — state withholding certificate
// ---------------------------------------------------------------------------

const stateSchema = z.object({ effectiveFrom: isoDate, signatureName: signature, data: hrUsStateCertificateElectionSchema });
type StateValues = z.input<typeof stateSchema>;

function StateForm({ target, mode, defaultName, onSubmit, onClose }: Readonly<DialogProps>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const state = target.state ?? '';
  const certificate = target.certificate ?? stateModule(state)?.certificate ?? null;
  const [saving, setSaving] = useState(false);

  const form = useForm<StateValues, unknown, z.output<typeof stateSchema>>({
    resolver: zodResolver(stateSchema),
    defaultValues: {
      effectiveFrom: todayIso(),
      signatureName: defaultName,
      data: {
        filingStatus: certificate?.filingStatuses?.[0] ?? null,
        allowances: certificate?.usesAllowances ? 0 : null,
        values: Object.fromEntries((certificate?.fields ?? []).map((field) => [field.key, field.type === 'boolean' ? false : null])),
        extraWithholding: null,
        exempt: false,
      },
    },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function submit(values: z.output<typeof stateSchema>) {
    setSaving(true);
    try {
      await onSubmit({ kind: 'us_state_certificate', state, effectiveFrom: values.effectiveFrom, data: values.data, signatureName: values.signatureName });
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.elections.failed')) });
    } finally {
      setSaving(false);
    }
  }

  if (!certificate) {
    return (
      <div className="space-y-4">
        <InfoLine>{t('weldhr.payroll.elections.state.noCertificate', { state })}</InfoLine>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  function renderField(field: StateCertificateFieldDef) {
    const name = `data.values.${field.key}` as const;
    const label = labels.stateField(state, field.key);
    switch (field.type) {
      case 'select':
        return (
          <SelectField
            key={field.key}
            control={form.control}
            name={name}
            label={label}
            options={(field.options ?? []).map((option) => ({ value: option, label: labels.stateOption(state, field.key, option) }))}
          />
        );
      case 'boolean':
        return <SwitchField key={field.key} control={form.control} name={name} label={label} />;
      default:
        return <NumberField key={field.key} control={form.control} name={name} label={label} />;
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <ErrorBanner error={failure} />
        <InfoLine>{t('weldhr.payroll.elections.state.formName', { form: certificate.formName, state })}</InfoLine>
        {certificate.filingStatuses && certificate.filingStatuses.length > 0 && (
          <SelectField
            control={form.control}
            name="data.filingStatus"
            label={t('weldhr.payroll.elections.state.filingStatus')}
            options={certificate.filingStatuses.map((status) => ({ value: status, label: labels.stateOption(state, 'filingStatus', status) }))}
          />
        )}
        {certificate.usesAllowances && <NumberField control={form.control} name="data.allowances" label={t('weldhr.payroll.elections.state.allowances')} />}
        {certificate.fields.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{certificate.fields.map(renderField)}</div>}
        <NumberField control={form.control} name="data.extraWithholding" label={t('weldhr.payroll.elections.state.extraWithholding')} />
        <SwitchField control={form.control} name="data.exempt" label={t('weldhr.payroll.elections.state.exempt')} description={t('weldhr.payroll.elections.state.exemptHint')} />
        <TextField control={form.control} name="effectiveFrom" label={t('weldhr.payroll.elections.effectiveFrom')} type="date" emptyAs="string" />
        <SignatureFooter mode={mode} saving={saving} onClose={onClose} />
      </form>
    </Form>
  );
}
