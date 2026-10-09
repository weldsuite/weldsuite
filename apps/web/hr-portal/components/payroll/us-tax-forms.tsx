'use client';

import { useState, type FormEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { todayInZone } from '@/lib/date';
import { humanizeKey } from '@/lib/payroll/format';
import { getStateCertificate, stateCertificateFieldLabel } from '@/lib/payroll/state-certificates';
import { usStateName } from '@/lib/payroll/us-states';
import { parseAllowances, parseAmount } from '@/lib/payroll/validate';
import type { HrTaxElection, HrUsFilingStatus, HrUsStateCertificateData } from '@/lib/payroll/types';
import { Button, Input, Label, Select } from '@/components/ui/primitives';
import { Checkbox, ElectionCard, SignatureBlock } from '@/components/payroll/election-parts';
import { useSignElection } from '@/components/payroll/use-sign-election';

const FILING_STATUSES: HrUsFilingStatus[] = ['single', 'married_jointly', 'head_of_household'];

function isFilingStatus(value: unknown): value is HrUsFilingStatus {
  return typeof value === 'string' && (FILING_STATUSES as string[]).includes(value);
}

function amountText(value: unknown): string {
  return typeof value === 'number' && value !== 0 ? String(value) : '';
}

function MoneyField({
  id,
  label,
  hint,
  value,
  onChange,
}: Readonly<{ id: string; label: string; hint: string; value: string; onChange: (value: string) => void }>) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">
        {hint}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Federal Form W-4
// ---------------------------------------------------------------------------

interface W4Fields {
  filingStatus: HrUsFilingStatus;
  multipleJobs: boolean;
  dependentsAmount: string;
  otherIncome: string;
  deductions: string;
  extraWithholding: string;
  exempt: boolean;
  nonresidentAlien: boolean;
}

function readW4(election: HrTaxElection | null): W4Fields {
  const data = election?.data ?? {};
  return {
    filingStatus: isFilingStatus(data.filingStatus) ? data.filingStatus : 'single',
    multipleJobs: data.multipleJobs === true,
    dependentsAmount: amountText(data.dependentsAmount),
    otherIncome: amountText(data.otherIncome),
    deductions: amountText(data.deductions),
    extraWithholding: amountText(data.extraWithholding),
    exempt: data.exempt === true,
    nonresidentAlien: data.nonresidentAlien === true,
  };
}

function W4Form({
  slug,
  initial,
  onDone,
  onCancel,
}: Readonly<{ slug: string; initial: W4Fields; onDone: () => void; onCancel: (() => void) | null }>) {
  const { dict, timeZone } = useI18n();
  const t = dict.payroll.taxForms;
  const [fields, setFields] = useState<W4Fields>(initial);
  const [name, setName] = useState('');
  const { submitting, error, setError, sign } = useSignElection(slug);

  function set<K extends keyof W4Fields>(key: K, value: W4Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(dict.payroll.errors.signatureRequired);
      return;
    }
    // A claim of exemption overrides Steps 2 to 4, so those are sent as "none".
    const dependentsAmount = fields.exempt ? 0 : parseAmount(fields.dependentsAmount);
    const otherIncome = fields.exempt ? 0 : parseAmount(fields.otherIncome);
    const deductions = fields.exempt ? 0 : parseAmount(fields.deductions);
    const extraWithholding = fields.exempt ? 0 : parseAmount(fields.extraWithholding);
    if (dependentsAmount === null || otherIncome === null || deductions === null || extraWithholding === null) {
      setError(dict.payroll.errors.invalidAmount);
      return;
    }
    const effectiveFrom = todayInZone(timeZone);
    const stored = await sign({
      kind: 'us_w4',
      effectiveFrom,
      data: {
        formYear: Number(effectiveFrom.slice(0, 4)),
        filingStatus: fields.filingStatus,
        multipleJobs: fields.exempt ? false : fields.multipleJobs,
        dependentsAmount,
        otherIncome,
        deductions,
        extraWithholding,
        exempt: fields.exempt,
        nonresidentAlien: fields.nonresidentAlien,
      },
      signatureName: name.trim(),
    });
    if (stored) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="w4-filing-status">{t.us.filingStatus}</Label>
        <Select
          id="w4-filing-status"
          value={fields.filingStatus}
          onChange={(e) => {
            if (isFilingStatus(e.target.value)) set('filingStatus', e.target.value);
          }}
        >
          {FILING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t.us.filingStatuses[status]}
            </option>
          ))}
        </Select>
      </div>

      <Checkbox
        id="w4-exempt"
        checked={fields.exempt}
        onChange={(checked) => set('exempt', checked)}
        label={t.us.exempt}
        hint={t.us.exemptHint}
      />

      {!fields.exempt && (
        <>
          <Checkbox
            id="w4-multiple-jobs"
            checked={fields.multipleJobs}
            onChange={(checked) => set('multipleJobs', checked)}
            label={t.us.multipleJobs}
            hint={t.us.multipleJobsHint}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyField
              id="w4-dependents"
              label={t.us.dependentsAmount}
              hint={t.us.dependentsAmountHint}
              value={fields.dependentsAmount}
              onChange={(value) => set('dependentsAmount', value)}
            />
            <MoneyField
              id="w4-other-income"
              label={t.us.otherIncome}
              hint={t.us.otherIncomeHint}
              value={fields.otherIncome}
              onChange={(value) => set('otherIncome', value)}
            />
            <MoneyField
              id="w4-deductions"
              label={t.us.deductions}
              hint={t.us.deductionsHint}
              value={fields.deductions}
              onChange={(value) => set('deductions', value)}
            />
            <MoneyField
              id="w4-extra"
              label={t.us.extraWithholding}
              hint={t.us.extraWithholdingHint}
              value={fields.extraWithholding}
              onChange={(value) => set('extraWithholding', value)}
            />
          </div>
        </>
      )}

      <Checkbox
        id="w4-nra"
        checked={fields.nonresidentAlien}
        onChange={(checked) => set('nonresidentAlien', checked)}
        label={t.us.nonresidentAlien}
      />

      <SignatureBlock
        id="w4-signature"
        name={name}
        onNameChange={setName}
        submitting={submitting}
        error={error}
        statement={t.us.perjury}
      />
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {dict.common.cancel}
        </Button>
      )}
    </form>
  );
}

/** US: the federal Form W-4, signed with a typed name. */
export function UsW4Card({ slug, election }: Readonly<{ slug: string; election: HrTaxElection | null }>) {
  const { dict } = useI18n();
  const t = dict.payroll.taxForms;
  const current = readW4(election);
  return (
    <ElectionCard
      title={t.us.w4Title}
      intro={t.us.w4Intro}
      election={election}
      summary={current.exempt ? t.us.summaryExempt : t.us.filingStatuses[current.filingStatus]}
    >
      {({ close, canCancel }) => (
        <W4Form slug={slug} initial={current} onDone={close} onCancel={canCancel ? close : null} />
      )}
    </ElectionCard>
  );
}

// ---------------------------------------------------------------------------
// State withholding certificate
// ---------------------------------------------------------------------------

interface StateFields {
  filingStatus: string;
  allowances: string;
  extraWithholding: string;
  exempt: boolean;
  /** One entry per extra field of the state's form: text for select/number/money, boolean for checkboxes. */
  values: Record<string, string | boolean>;
}

function readState(election: HrTaxElection | null): StateFields {
  const data: HrUsStateCertificateData = election?.data ?? {};
  const values: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(data.values ?? {})) {
    if (typeof value === 'boolean') values[key] = value;
    else if (typeof value === 'number' || typeof value === 'string') values[key] = String(value);
  }
  return {
    filingStatus: typeof data.filingStatus === 'string' ? data.filingStatus : '',
    allowances: typeof data.allowances === 'number' ? String(data.allowances) : '',
    extraWithholding: amountText(data.extraWithholding),
    exempt: data.exempt === true,
    values,
  };
}

type CertificateValues = NonNullable<HrUsStateCertificateData['values']>;

function StateForm({
  slug,
  state,
  initial,
  onDone,
  onCancel,
}: Readonly<{ slug: string; state: string; initial: StateFields; onDone: () => void; onCancel: (() => void) | null }>) {
  const { dict, locale, format, timeZone } = useI18n();
  const t = dict.payroll.taxForms;
  const definition = getStateCertificate(state);
  const stateName = usStateName(state);
  const [fields, setFields] = useState<StateFields>(initial);
  const [name, setName] = useState('');
  const { submitting, error, setError, sign } = useSignElection(slug);

  const showAllowances = definition ? definition.usesAllowances : true;

  function set<K extends keyof StateFields>(key: K, value: StateFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function setValue(key: string, value: string | boolean) {
    setFields((current) => ({ ...current, values: { ...current.values, [key]: value } }));
  }

  /** The certificate's extra fields as the API wants them, or the message of the first one that is wrong. */
  function collectValues(): { values: CertificateValues } | { problem: string } {
    const values: CertificateValues = {};
    for (const field of definition?.fields ?? []) {
      const raw = fields.values[field.key];
      if (field.type === 'boolean') {
        values[field.key] = raw === true;
        continue;
      }
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') {
        if (field.required) {
          return { problem: field.type === 'select' ? dict.payroll.errors.choiceRequired : dict.payroll.errors.invalidAmount };
        }
        continue;
      }
      if (field.type === 'select') {
        values[field.key] = text;
        continue;
      }
      const amount = parseAmount(text);
      if (amount === null) return { problem: dict.payroll.errors.invalidAmount };
      values[field.key] = amount;
    }
    return { values };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(dict.payroll.errors.signatureRequired);
      return;
    }

    const data: HrUsStateCertificateData = { exempt: fields.exempt };
    if (!fields.exempt) {
      if (fields.filingStatus.trim()) data.filingStatus = fields.filingStatus.trim();

      if (showAllowances) {
        const allowances = parseAllowances(fields.allowances);
        if (allowances === null) {
          setError(dict.payroll.errors.invalidAllowances);
          return;
        }
        if (allowances !== undefined) data.allowances = allowances;
      }

      const extra = parseAmount(fields.extraWithholding);
      if (extra === null) {
        setError(dict.payroll.errors.invalidAmount);
        return;
      }
      if (extra > 0) data.extraWithholding = extra;

      const collected = collectValues();
      if ('problem' in collected) {
        setError(collected.problem);
        return;
      }
      if (Object.keys(collected.values).length > 0) data.values = collected.values;
    }

    const stored = await sign({
      kind: 'us_state_certificate',
      state,
      effectiveFrom: todayInZone(timeZone),
      data,
      signatureName: name.trim(),
    });
    if (stored) onDone();
  }

  const idPrefix = `state-${state.toLowerCase()}`;

  return (
    <form onSubmit={submit} className="space-y-4">
      <Checkbox
        id={`${idPrefix}-exempt`}
        checked={fields.exempt}
        onChange={(checked) => set('exempt', checked)}
        label={format(t.us.stateExempt, { state: stateName })}
      />

      {!fields.exempt && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${idPrefix}-filing-status`}>
              {t.us.filingStatus}
              {!definition?.filingStatuses && <span className="text-gray-400 font-normal"> ({dict.common.optional})</span>}
            </Label>
            {definition?.filingStatuses ? (
              <Select
                id={`${idPrefix}-filing-status`}
                value={fields.filingStatus}
                onChange={(e) => set('filingStatus', e.target.value)}
                required
              >
                <option value="" disabled>
                  {dict.payroll.details.select}
                </option>
                {definition.filingStatuses.map((status) => (
                  <option key={status} value={status}>
                    {humanizeKey(status)}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={`${idPrefix}-filing-status`}
                value={fields.filingStatus}
                maxLength={40}
                onChange={(e) => set('filingStatus', e.target.value)}
              />
            )}
          </div>

          {showAllowances && (
            <div>
              <Label htmlFor={`${idPrefix}-allowances`}>{t.us.allowances}</Label>
              <Input
                id={`${idPrefix}-allowances`}
                type="number"
                inputMode="numeric"
                min="0"
                max="99"
                step="1"
                placeholder="0"
                value={fields.allowances}
                onChange={(e) => set('allowances', e.target.value)}
              />
            </div>
          )}

          {(definition?.fields ?? []).map((field) => {
            const id = `${idPrefix}-${field.key}`;
            const label = stateCertificateFieldLabel(state, field.key, locale);
            const raw = fields.values[field.key];
            if (field.type === 'boolean') {
              return (
                <div key={field.key} className="sm:col-span-2">
                  <Checkbox id={id} checked={raw === true} onChange={(checked) => setValue(field.key, checked)} label={label} />
                </div>
              );
            }
            if (field.type === 'select') {
              return (
                <div key={field.key}>
                  <Label htmlFor={id}>{label}</Label>
                  <Select
                    id={id}
                    value={typeof raw === 'string' ? raw : ''}
                    onChange={(e) => setValue(field.key, e.target.value)}
                    required={field.required}
                  >
                    <option value="" disabled={field.required}>
                      {dict.payroll.details.select}
                    </option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {humanizeKey(option)}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }
            return (
              <div key={field.key}>
                <Label htmlFor={id}>{label}</Label>
                <Input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step={field.type === 'money' ? '0.01' : 'any'}
                  placeholder="0"
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  required={field.required}
                />
              </div>
            );
          })}

          <div>
            <Label htmlFor={`${idPrefix}-extra`}>{t.us.stateExtraWithholding}</Label>
            <Input
              id={`${idPrefix}-extra`}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0"
              value={fields.extraWithholding}
              onChange={(e) => set('extraWithholding', e.target.value)}
            />
          </div>
        </div>
      )}

      <SignatureBlock
        id={`${idPrefix}-signature`}
        name={name}
        onNameChange={setName}
        submitting={submitting}
        error={error}
        statement={t.us.perjury}
      />
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {dict.common.cancel}
        </Button>
      )}
    </form>
  );
}

/** US: one state's withholding certificate, rendered from the state's own definition (generic when there is none). */
export function UsStateCertificateCard({
  slug,
  state,
  election,
}: Readonly<{ slug: string; state: string; election: HrTaxElection | null }>) {
  const { dict, format } = useI18n();
  const t = dict.payroll.taxForms;
  const definition = getStateCertificate(state);
  const stateName = usStateName(state);
  const current = readState(election);
  const title = format(t.us.stateTitle, { state: stateName });
  let summary: string | null = null;
  if (current.exempt) summary = t.us.summaryExempt;
  else if (current.filingStatus) summary = humanizeKey(current.filingStatus);
  return (
    <ElectionCard
      title={definition?.formName ? `${title} (${definition.formName})` : title}
      intro={format(t.us.stateIntro, { state: stateName })}
      election={election}
      summary={summary}
    >
      {({ close, canCancel }) => (
        <StateForm slug={slug} state={state} initial={current} onDone={close} onCancel={canCancel ? close : null} />
      )}
    </ElectionCard>
  );
}
