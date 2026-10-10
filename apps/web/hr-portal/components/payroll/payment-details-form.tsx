'use client';

import { useState, type FormEvent, type HTMLInputTypeAttribute, type ReactNode } from 'react';
import { portalPut } from '@/lib/client';
import { formatDate, todayInZone } from '@/lib/date';
import { useSetPayrollDetails } from '@/lib/hooks/use-payroll-status';
import { useI18n } from '@/lib/i18n';
import { buildDetailsPayload, toValues, type DetailsErrors, type DetailsValues } from '@/lib/payroll/details-form';
import { missingSections, type MissingGroup } from '@/lib/payroll/missing';
import { US_STATE_NAMES } from '@/lib/payroll/us-states';
import type {
  HrBankAccountType,
  HrIdDocumentType,
  HrMyPayrollDetails,
  HrPayrollCountry,
  HrPayrollPaymentDetailsMasked,
} from '@/lib/payroll/types';
import { Button, Input, Label, Select } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';

const ACCOUNT_TYPES: HrBankAccountType[] = ['checking', 'savings'];
const ID_DOCUMENT_TYPES: HrIdDocumentType[] = ['passport', 'id_card', 'residence_permit', 'drivers_license'];

function FieldError({ id, message }: Readonly<{ id: string; message?: string }>) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-600">
      {message}
    </p>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  optional,
  type = 'text',
  inputMode,
  autoComplete = 'off',
  maxLength,
  max,
  className,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  optional?: boolean;
  type?: HTMLInputTypeAttribute;
  inputMode?: 'text' | 'numeric' | 'decimal';
  autoComplete?: string;
  maxLength?: number;
  max?: string;
  className?: string;
}>) {
  const { dict } = useI18n();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <Label htmlFor={id}>
        {label}
        {optional && <span className="text-gray-400 font-normal"> ({dict.common.optional})</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        max={max}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">
          {hint}
        </p>
      )}
      <FieldError id={id} message={error} />
    </div>
  );
}

/**
 * A number the API only ever returns masked (BSN/SSN, IBAN, account number).
 * Shows what is on file with a "Change" button; typing a new value replaces
 * it, leaving the field alone keeps it.
 */
function SecretField({
  id,
  label,
  masked,
  value,
  onChange,
  error,
  hint,
  inputMode,
}: Readonly<{
  id: string;
  label: string;
  masked: string | null;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  inputMode?: 'text' | 'numeric';
}>) {
  const { dict } = useI18n();
  const [editing, setEditing] = useState(!masked);

  if (masked && !editing) {
    return (
      <div>
        <p className="block text-sm font-medium text-gray-700 mb-1.5">{label}</p>
        <div className="flex items-center gap-3 min-h-[44px]">
          <span className="font-mono text-sm text-gray-900" aria-label={`${label}, ${dict.payroll.details.onFile}`}>
            {masked}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm text-gray-600 underline underline-offset-2"
          >
            {dict.payroll.details.change}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <TextField
        id={id}
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        hint={hint}
        inputMode={inputMode}
        autoComplete="off"
        maxLength={40}
      />
      {masked && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            setEditing(false);
          }}
          className="mt-1 text-xs text-gray-600 underline underline-offset-2"
        >
          {dict.common.cancel}
        </button>
      )}
    </div>
  );
}

function Section({ title, needed, children }: Readonly<{ title: string; needed: boolean; children: ReactNode }>) {
  const { dict } = useI18n();
  return (
    <fieldset className="space-y-4 min-w-0">
      <legend className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-3">
        {title}
        {needed && <Badge tone="warning">{dict.payroll.details.needed}</Badge>}
      </legend>
      {children}
    </fieldset>
  );
}

function IdDocumentStatus({ details }: Readonly<{ details: HrPayrollPaymentDetailsMasked }>) {
  const { dict, locale, timeZone, format } = useI18n();
  const t = dict.payroll.details;
  if (!details.idDocumentType) return null;
  const parts = [format(t.idOnFile, { type: t.idDocumentTypes[details.idDocumentType] })];
  if (details.idDocumentExpiresOn) {
    parts.push(format(t.idExpires, { date: formatDate(details.idDocumentExpiresOn, locale, timeZone) }));
  }
  return (
    <div className="text-sm text-gray-700">
      <p>{parts.join(' · ')}</p>
      <p className="text-xs text-gray-500">
        {details.idVerifiedAt
          ? format(t.idVerified, { date: formatDate(details.idVerifiedAt, locale, timeZone) })
          : t.idNotVerified}
      </p>
    </div>
  );
}

/**
 * What payroll holds about the employee, and the means to fill in what is
 * missing. Identity, bank and address fields differ per country (BSN, IBAN
 * and a Dutch address; SSN, routing and account number and a US address).
 */
export function PaymentDetailsForm({
  slug,
  country,
  details,
}: Readonly<{ slug: string; country: HrPayrollCountry; details: HrMyPayrollDetails }>) {
  const { dict, timeZone } = useI18n();
  const t = dict.payroll.details;
  const setDetails = useSetPayrollDetails(slug);
  const stored = details.paymentDetails;

  const [initial, setInitial] = useState<DetailsValues>(() => toValues(stored, country));
  const [values, setValues] = useState<DetailsValues>(initial);
  // Bumped whenever the stored details change, so the write-only fields start over.
  const [version, setVersion] = useState(0);
  const [seen, setSeen] = useState(stored);
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // The stored details changed (our own save, or HR editing them): show them.
  if (seen !== stored) {
    const next = toValues(stored, country);
    setSeen(stored);
    setInitial(next);
    setValues(next);
    setVersion((current) => current + 1);
  }

  const today = todayInZone(timeZone);
  const { groups } = missingSections(details.missing);
  const needs = (group: MissingGroup) => groups.has(group);
  const dirty = Object.keys(buildDetailsPayload(values, initial, country, dict, today).payload).length > 0;

  function set<K extends keyof DetailsValues>(key: K, value: DetailsValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setServerError(null);
    const { payload, errors: found } = buildDetailsPayload(values, initial, country, dict, today);
    setErrors(found);
    if (Object.keys(found).length > 0 || Object.keys(payload).length === 0) return;
    setSaving(true);
    try {
      const next = await portalPut<HrMyPayrollDetails>(slug, '/employee/payroll-details', payload);
      setDetails(next);
      setSaved(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : dict.errors.generic);
    } finally {
      setSaving(false);
    }
  }

  const isNl = country === 'NL';

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Section title={t.sections.identity} needed={needs('nationalId') || needs('dateOfBirth')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="dob"
            type="date"
            label={t.dateOfBirth}
            value={values.dateOfBirth}
            max={today}
            autoComplete="bday"
            onChange={(v) => set('dateOfBirth', v)}
            error={errors.dateOfBirth}
          />
          <SecretField
            key={`national-id-${version}`}
            id="national-id"
            label={isNl ? t.bsn : t.ssn}
            masked={stored.hasNationalId ? stored.nationalIdMasked : null}
            value={values.nationalId}
            onChange={(v) => set('nationalId', v)}
            error={errors.nationalId}
            hint={isNl ? t.nationalIdHintNl : t.nationalIdHintUs}
            inputMode="numeric"
          />
        </div>
      </Section>

      <Section title={t.sections.bank} needed={needs('bank')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="bank-holder"
            label={t.accountHolder}
            value={values.bankAccountHolder}
            maxLength={140}
            autoComplete="name"
            onChange={(v) => set('bankAccountHolder', v)}
            error={errors.bankAccountHolder}
            className="sm:col-span-2"
          />
          {isNl ? (
            <>
              <SecretField
                key={`iban-${version}`}
                id="bank-iban"
                label={t.iban}
                masked={stored.bankIbanMasked}
                value={values.bankIban}
                onChange={(v) => set('bankIban', v)}
                error={errors.bankIban}
              />
              <TextField
                id="bank-bic"
                label={t.bic}
                optional
                value={values.bankBic}
                maxLength={11}
                onChange={(v) => set('bankBic', v)}
                error={errors.bankBic}
              />
            </>
          ) : (
            <>
              <TextField
                id="bank-routing"
                label={t.routingNumber}
                inputMode="numeric"
                value={values.bankRoutingNumber}
                maxLength={9}
                onChange={(v) => set('bankRoutingNumber', v)}
                error={errors.bankRoutingNumber}
              />
              <SecretField
                key={`account-number-${version}`}
                id="bank-account-number"
                label={t.accountNumber}
                masked={stored.bankAccountNumberMasked}
                value={values.bankAccountNumber}
                onChange={(v) => set('bankAccountNumber', v)}
                error={errors.bankAccountNumber}
                inputMode="numeric"
              />
              <div>
                <Label htmlFor="bank-account-type">{t.accountType}</Label>
                <Select
                  id="bank-account-type"
                  value={values.bankAccountType}
                  onChange={(e) => {
                    const next = ACCOUNT_TYPES.find((type) => type === e.target.value);
                    set('bankAccountType', next ?? '');
                  }}
                >
                  <option value="">{t.select}</option>
                  {ACCOUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t.accountTypes[type]}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}
        </div>
      </Section>

      <Section title={t.sections.address} needed={needs('address')}>
        <div className="grid gap-4 sm:grid-cols-6">
          {isNl ? (
            <>
              <TextField
                id="address-line1"
                label={t.street}
                value={values.line1}
                maxLength={255}
                autoComplete="address-line1"
                onChange={(v) => set('line1', v)}
                className="sm:col-span-3"
              />
              <TextField
                id="address-house-number"
                label={t.houseNumber}
                value={values.houseNumber}
                maxLength={20}
                onChange={(v) => set('houseNumber', v)}
                className="sm:col-span-2"
              />
              <TextField
                id="address-house-number-addition"
                label={t.houseNumberAddition}
                optional
                value={values.houseNumberAddition}
                maxLength={20}
                onChange={(v) => set('houseNumberAddition', v)}
                className="sm:col-span-1"
              />
              <TextField
                id="address-postal-code"
                label={t.postalCode}
                value={values.postalCode}
                maxLength={20}
                autoComplete="postal-code"
                onChange={(v) => set('postalCode', v)}
                className="sm:col-span-2"
              />
              <TextField
                id="address-city"
                label={t.city}
                value={values.city}
                maxLength={120}
                autoComplete="address-level2"
                onChange={(v) => set('city', v)}
                className="sm:col-span-4"
              />
            </>
          ) : (
            <>
              <TextField
                id="address-line1"
                label={t.streetAddress}
                value={values.line1}
                maxLength={255}
                autoComplete="address-line1"
                onChange={(v) => set('line1', v)}
                className="sm:col-span-6"
              />
              <TextField
                id="address-line2"
                label={t.addressLine2}
                optional
                value={values.line2}
                maxLength={255}
                autoComplete="address-line2"
                onChange={(v) => set('line2', v)}
                className="sm:col-span-6"
              />
              <TextField
                id="address-city"
                label={t.city}
                value={values.city}
                maxLength={120}
                autoComplete="address-level2"
                onChange={(v) => set('city', v)}
                className="sm:col-span-3"
              />
              <div className="sm:col-span-2">
                <Label htmlFor="address-region">{t.state}</Label>
                <Select
                  id="address-region"
                  value={values.region}
                  autoComplete="address-level1"
                  onChange={(e) => set('region', e.target.value)}
                >
                  <option value="">{t.select}</option>
                  {Object.entries(US_STATE_NAMES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </Select>
              </div>
              <TextField
                id="address-postal-code"
                label={t.zip}
                inputMode="numeric"
                value={values.postalCode}
                maxLength={20}
                autoComplete="postal-code"
                onChange={(v) => set('postalCode', v)}
                className="sm:col-span-1"
              />
            </>
          )}
          <TextField
            id="address-country"
            label={t.country}
            hint={t.countryHint}
            value={values.country}
            maxLength={2}
            autoComplete="country"
            onChange={(v) => set('country', v.toUpperCase())}
            error={errors.country}
            className="sm:col-span-2"
          />
        </div>
      </Section>

      <Section title={t.sections.idDocument} needed={needs('idDocument')}>
        <IdDocumentStatus details={stored} />
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="id-document-type">{t.idDocumentType}</Label>
            <Select
              id="id-document-type"
              value={values.idDocumentType}
              onChange={(e) => {
                const next = ID_DOCUMENT_TYPES.find((type) => type === e.target.value);
                set('idDocumentType', next ?? '');
              }}
            >
              <option value="">{t.select}</option>
              {ID_DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t.idDocumentTypes[type]}
                </option>
              ))}
            </Select>
          </div>
          <TextField
            id="id-document-number"
            label={t.idDocumentNumber}
            hint={t.idDocumentNumberHint}
            value={values.idDocumentNumber}
            maxLength={40}
            onChange={(v) => set('idDocumentNumber', v)}
          />
          <TextField
            id="id-document-expires"
            type="date"
            label={t.idDocumentExpiresOn}
            value={values.idDocumentExpiresOn}
            onChange={(v) => set('idDocumentExpiresOn', v)}
            error={errors.idDocumentExpiresOn}
          />
        </div>
      </Section>

      <div className="space-y-2">
        {serverError && (
          <p role="alert" className="text-sm text-red-600">
            {serverError}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-emerald-700">
            {t.saved}
          </p>
        )}
        <Button type="submit" disabled={saving || !dirty}>
          {saving ? t.saving : t.save}
        </Button>
      </div>
    </form>
  );
}
