/**
 * The payroll details form's data model: the masked answer of the API turned
 * into form values, and the form values turned back into the smallest
 * `PUT /employee/payroll-details` body that carries what the employee changed.
 */

import type { Dictionary } from '@/lib/i18n';
import {
  isValidAccountNumber,
  isValidBsn,
  isValidIban,
  isValidIsoDate,
  isValidRoutingNumber,
  isValidSsn,
} from '@/lib/payroll/validate';
import type {
  HrBankAccountType,
  HrIdDocumentType,
  HrPayrollAddress,
  HrPayrollCountry,
  HrPayrollPaymentDetailsInput,
  HrPayrollPaymentDetailsMasked,
} from '@/lib/payroll/types';

export interface DetailsValues {
  dateOfBirth: string;
  /** Write-only: always starts empty. */
  nationalId: string;
  bankAccountHolder: string;
  /** Write-only. */
  bankIban: string;
  bankBic: string;
  bankRoutingNumber: string;
  /** Write-only. */
  bankAccountNumber: string;
  bankAccountType: '' | HrBankAccountType;
  line1: string;
  line2: string;
  houseNumber: string;
  houseNumberAddition: string;
  postalCode: string;
  city: string;
  region: string;
  country: string;
  idDocumentType: '' | HrIdDocumentType;
  /** Write-only. */
  idDocumentNumber: string;
  idDocumentExpiresOn: string;
}

export type DetailsErrors = Partial<Record<keyof DetailsValues, string>>;

export function toValues(details: HrPayrollPaymentDetailsMasked, country: HrPayrollCountry): DetailsValues {
  const address = details.homeAddress;
  return {
    dateOfBirth: details.dateOfBirth?.slice(0, 10) ?? '',
    nationalId: '',
    bankAccountHolder: details.bankAccountHolder ?? '',
    bankIban: '',
    bankBic: details.bankBic ?? '',
    bankRoutingNumber: details.bankRoutingNumber ?? '',
    bankAccountNumber: '',
    bankAccountType: details.bankAccountType ?? '',
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    houseNumber: address?.houseNumber ?? '',
    houseNumberAddition: address?.houseNumberAddition ?? '',
    postalCode: address?.postalCode ?? '',
    city: address?.city ?? '',
    region: address?.region ?? '',
    // A first address is almost always in the country the payroll runs in.
    country: address?.country ?? country,
    idDocumentType: details.idDocumentType ?? '',
    idDocumentNumber: '',
    idDocumentExpiresOn: details.idDocumentExpiresOn?.slice(0, 10) ?? '',
  };
}

/** The address fields each country's form shows (the rest are left out of the saved address). */
const ADDRESS_FIELDS: Record<HrPayrollCountry, ReadonlyArray<keyof HrPayrollAddress & keyof DetailsValues>> = {
  NL: ['line1', 'houseNumber', 'houseNumberAddition', 'postalCode', 'city'],
  US: ['line1', 'line2', 'city', 'region', 'postalCode'],
};

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Checks what the employee typed and builds the request body.
 *
 * Only what changed is sent, so a masked number the employee left alone is
 * never overwritten. An emptied plain field is sent as `null` (cleared). The
 * API checks everything again; this only catches typing mistakes early.
 */
export function buildDetailsPayload(
  values: DetailsValues,
  initial: DetailsValues,
  country: HrPayrollCountry,
  dict: Dictionary,
  today: string,
): { payload: HrPayrollPaymentDetailsInput; errors: DetailsErrors } {
  const t = dict.payroll.errors;
  const payload: HrPayrollPaymentDetailsInput = {};
  const errors: DetailsErrors = {};
  const changed = (key: keyof DetailsValues) => values[key].trim() !== initial[key].trim();

  if (changed('dateOfBirth')) {
    const dob = values.dateOfBirth.trim();
    if (dob === '') payload.dateOfBirth = null;
    else if (isValidIsoDate(dob) && dob <= today && dob >= '1900-01-01') payload.dateOfBirth = dob;
    else errors.dateOfBirth = t.invalidDate;
  }

  const nationalId = values.nationalId.trim();
  if (nationalId !== '') {
    const valid = country === 'NL' ? isValidBsn(nationalId) : isValidSsn(nationalId);
    if (valid) payload.nationalId = nationalId;
    else errors.nationalId = country === 'NL' ? t.invalidBsn : t.invalidSsn;
  }

  if (changed('bankAccountHolder')) payload.bankAccountHolder = orNull(values.bankAccountHolder);

  if (country === 'NL') {
    const iban = values.bankIban.trim();
    if (iban !== '') {
      if (isValidIban(iban)) payload.bankIban = iban.replace(/\s+/g, '').toUpperCase();
      else errors.bankIban = t.invalidIban;
    }
    if (changed('bankBic')) payload.bankBic = orNull(values.bankBic)?.toUpperCase() ?? null;
  } else {
    if (changed('bankRoutingNumber')) {
      const routing = values.bankRoutingNumber.trim();
      if (routing === '') payload.bankRoutingNumber = null;
      else if (isValidRoutingNumber(routing)) payload.bankRoutingNumber = routing;
      else errors.bankRoutingNumber = t.invalidRouting;
    }
    const accountNumber = values.bankAccountNumber.trim();
    if (accountNumber !== '') {
      if (isValidAccountNumber(accountNumber)) payload.bankAccountNumber = accountNumber;
      else errors.bankAccountNumber = t.invalidAccountNumber;
    }
    if (changed('bankAccountType')) payload.bankAccountType = values.bankAccountType === '' ? null : values.bankAccountType;
  }

  const addressFields = ADDRESS_FIELDS[country];
  if (changed('country') || addressFields.some((key) => changed(key))) {
    const country2 = values.country.trim().toUpperCase();
    const hasAnyLine = addressFields.some((key) => values[key].trim() !== '');
    if (!hasAnyLine) {
      payload.homeAddress = null;
    } else if (/^[A-Z]{2}$/.test(country2)) {
      const address: HrPayrollAddress = { country: country2 };
      for (const key of addressFields) address[key] = orNull(values[key]);
      payload.homeAddress = address;
    } else {
      errors.country = t.invalidCountry;
    }
  }

  if (changed('idDocumentType')) payload.idDocumentType = values.idDocumentType === '' ? null : values.idDocumentType;
  const documentNumber = values.idDocumentNumber.trim();
  if (documentNumber !== '') payload.idDocumentNumber = documentNumber;
  if (changed('idDocumentExpiresOn')) {
    const expires = values.idDocumentExpiresOn.trim();
    if (expires === '') payload.idDocumentExpiresOn = null;
    else if (isValidIsoDate(expires)) payload.idDocumentExpiresOn = expires;
    else errors.idDocumentExpiresOn = t.invalidDate;
  }

  return { payload, errors };
}
