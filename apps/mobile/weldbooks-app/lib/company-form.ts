/**
 * The company form: the draft the setup and edit sheets keep while typing, what
 * is wrong with it, and the update it makes to the stored company.
 *
 * Kept pure (no React, no network) so the rules can be unit-tested. The sheets
 * map the problem codes to the app language's messages.
 */

import { cnpjProblem, normalizeCnpj } from '@/lib/br';
import {
  btwProblem,
  formatIbanInput,
  ibanProblem,
  kvkProblem,
  normalizeBtw,
  normalizeIban,
  normalizeKvk,
  type InvoiceField,
} from '@/lib/company';
import type { Translations } from '@/lib/i18n/locales/en';
import { isUsJurisdiction } from '@/lib/jurisdiction';
import {
  EMPTY_ADDRESS,
  einProblem,
  isAddressBlank,
  normalizeEin,
  toAddressDraft,
  toApiAddress,
  type AddressDraft,
} from '@/lib/us';
import type { AccountingEntity, PostalAddress } from '@/types/accounting';

/** The company details the sheets keep while typing (text, never undefined). */
export interface CompanyDraft {
  name: string;
  /** BTW number, GSTIN, CNPJ or EIN: what the jurisdiction calls the company's tax ID. */
  taxId: string;
  /** KvK number, PAN, state ID, IE. */
  registrationNumber: string;
  iban: string;
  bic: string;
  address: AddressDraft;
}

export function emptyCompanyDraft(): CompanyDraft {
  return { name: '', taxId: '', registrationNumber: '', iban: '', bic: '', address: { ...EMPTY_ADDRESS } };
}

/** The company as the edit sheet starts: what is stored. A US company's tax ID is its EIN. */
export function toCompanyDraft(entity: AccountingEntity | null | undefined): CompanyDraft {
  if (!entity) return emptyCompanyDraft();
  const isUs = isUsJurisdiction(entity.jurisdictionCode);
  return {
    name: entity.name,
    taxId: (isUs ? (entity.ein ?? entity.vatNumber) : entity.vatNumber) ?? '',
    registrationNumber: entity.registrationNumber ?? '',
    iban: entity.iban ? formatIbanInput(entity.iban) : '',
    bic: entity.bic ?? '',
    address: toAddressDraft(entity.address),
  };
}

/** The tax ID as books-api stores it: the jurisdiction's own normal form. */
export function normalizeTaxId(value: string, code: string | null | undefined): string {
  switch (code?.toUpperCase()) {
    case 'US':
      return value.trim() ? normalizeEin(value) : '';
    case 'BR':
      return normalizeCnpj(value);
    case 'NL':
      return normalizeBtw(value);
    default:
      return value.trim();
  }
}

function normalizeRegistration(value: string, code: string | null | undefined): string {
  return code?.toUpperCase() === 'NL' ? normalizeKvk(value) : value.trim().replaceAll(/\s+/g, ' ');
}

/** A non-US address as the API takes it: trimmed, blank parts dropped, `country` set. Null for a blank address. */
export function toGenericAddress(draft: AddressDraft, country: string): PostalAddress | null {
  if (isAddressBlank(draft)) return null;
  const out: PostalAddress = { country };
  const line1 = draft.line1.trim();
  const line2 = draft.line2.trim();
  const city = draft.city.trim();
  const postalCode = draft.postalCode.trim();
  if (line1) out.line1 = line1;
  if (line2) out.line2 = line2;
  if (city) out.city = city;
  if (postalCode) out.postalCode = postalCode;
  return out;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/** What is wrong with the company details, by field; empty when they are fine. Blank optional fields are fine. */
export interface CompanyProblems {
  name?: 'required';
  taxId?: 'einFormat' | 'einPrefix' | 'cnpjFormat' | 'cnpjCheckDigits' | 'btwFormat';
  registrationNumber?: 'kvkFormat';
  iban?: 'ibanFormat' | 'ibanChecksum';
  /** A non-US address that is started has to say where: a street and a city. */
  address?: { line1?: 'required'; city?: 'required' };
}

function taxIdProblem(taxId: string, code: string | undefined): CompanyProblems['taxId'] {
  if (!taxId.trim()) return undefined;
  if (code === 'US') {
    const problem = einProblem(taxId);
    if (!problem) return undefined;
    return problem === 'format' ? 'einFormat' : 'einPrefix';
  }
  if (code === 'BR') {
    const problem = cnpjProblem(taxId);
    if (!problem) return undefined;
    return problem === 'format' ? 'cnpjFormat' : 'cnpjCheckDigits';
  }
  if (code === 'NL') return btwProblem(taxId) ? 'btwFormat' : undefined;
  return undefined;
}

function addressProblems(draft: AddressDraft, code: string | undefined): CompanyProblems['address'] {
  // A US address is checked by `usAddressProblems` (state and ZIP); the others need a street and a city.
  if (code === 'US' || isAddressBlank(draft)) return undefined;
  const problems: NonNullable<CompanyProblems['address']> = {};
  if (!draft.line1.trim()) problems.line1 = 'required';
  if (!draft.city.trim()) problems.city = 'required';
  return Object.keys(problems).length > 0 ? problems : undefined;
}

export function companyProblems(
  draft: CompanyDraft,
  options: { code: string | null | undefined; requireName?: boolean },
): CompanyProblems {
  const code = options.code?.toUpperCase();
  const problems: CompanyProblems = {};

  if (options.requireName && !draft.name.trim()) problems.name = 'required';

  const taxId = taxIdProblem(draft.taxId, code);
  if (taxId) problems.taxId = taxId;

  if (code === 'NL' && draft.registrationNumber.trim() && kvkProblem(draft.registrationNumber)) {
    problems.registrationNumber = 'kvkFormat';
  }

  if (draft.iban.trim()) {
    const iban = ibanProblem(draft.iban);
    if (iban) problems.iban = iban === 'format' ? 'ibanFormat' : 'ibanChecksum';
  }

  const address = addressProblems(draft.address, code);
  if (address) problems.address = address;
  return problems;
}

/** The message for a company problem, in the app language. */
export function companyProblemText(
  problem: NonNullable<CompanyProblems['taxId'] | CompanyProblems['registrationNumber'] | CompanyProblems['iban']>,
  t: Translations,
): string {
  switch (problem) {
    case 'einFormat':
      return t.entitySetup.einFormat;
    case 'einPrefix':
      return t.entitySetup.einPrefix;
    case 'cnpjFormat':
      return t.entitySetup.cnpjFormat;
    case 'cnpjCheckDigits':
      return t.entitySetup.cnpjCheckDigits;
    case 'btwFormat':
      return t.company.btwFormat;
    case 'kvkFormat':
      return t.company.kvkFormat;
    case 'ibanFormat':
      return t.company.ibanFormat;
    case 'ibanChecksum':
      return t.company.ibanChecksum;
  }
}

// ---------------------------------------------------------------------------
// The update
// ---------------------------------------------------------------------------

/** The fields of `PATCH /accounting-entities/:id` the edit sheet sets; only what changed. */
export interface EntityUpdate {
  name?: string;
  /** A blank value clears the identifier. A US company's EIN goes in `einOrSsn`. */
  taxIdentifiers?: { vatNumber?: string; registrationNumber?: string; einOrSsn?: string };
  /** Merged into the stored bank details by the API layer (the PATCH replaces the whole object). */
  bankDetails?: { iban?: string; bic?: string };
  address?: PostalAddress;
}

function sameAddress(draft: AddressDraft, address: PostalAddress | null | undefined): boolean {
  const stored = toAddressDraft(address);
  return (['line1', 'line2', 'city', 'state', 'postalCode'] as const).every(
    (key) => draft[key].trim() === stored[key].trim(),
  );
}

/**
 * The update for the changes a draft makes to the company: nothing for a field left as it was
 * (books-api re-checks every identifier it receives, so an untouched value is not sent), and no
 * address for a blank draft (an address can be replaced, not cleared).
 */
export function buildEntityUpdate(entity: AccountingEntity, draft: CompanyDraft): EntityUpdate {
  const code = entity.jurisdictionCode;
  const isUs = isUsJurisdiction(code);
  const stored = toCompanyDraft(entity);
  const update: EntityUpdate = {};

  const name = draft.name.trim();
  if (name && name !== entity.name) update.name = name;

  const taxId = normalizeTaxId(draft.taxId, code);
  if (taxId !== normalizeTaxId(stored.taxId, code)) {
    update.taxIdentifiers = { ...update.taxIdentifiers, [isUs ? 'einOrSsn' : 'vatNumber']: taxId };
  }

  const registration = normalizeRegistration(draft.registrationNumber, code);
  if (registration !== normalizeRegistration(stored.registrationNumber, code)) {
    update.taxIdentifiers = { ...update.taxIdentifiers, registrationNumber: registration };
  }

  const bank: NonNullable<EntityUpdate['bankDetails']> = {};
  const iban = normalizeIban(draft.iban);
  if (iban !== normalizeIban(stored.iban)) bank.iban = iban;
  const bic = draft.bic.trim().toUpperCase();
  if (bic !== stored.bic.trim().toUpperCase()) bank.bic = bic;
  if (Object.keys(bank).length > 0) update.bankDetails = bank;

  if (!isAddressBlank(draft.address) && !sameAddress(draft.address, entity.address)) {
    const address = isUs ? toApiAddress(draft.address) : toGenericAddress(draft.address, code.toUpperCase());
    if (address) update.address = address;
  }
  return update;
}

/** True when the update changes nothing. */
export function isEmptyUpdate(update: EntityUpdate): boolean {
  return Object.keys(update).length === 0;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The company fields in the words of the app language ("BTW-nummer", "KvK-nummer", "IBAN", "bedrijfsadres"). */
export function invoiceFieldNames(
  t: Translations,
  labels: { taxId: string; registrationId: string },
): Record<InvoiceField, string> {
  return {
    vatNumber: labels.taxId,
    registrationNumber: labels.registrationId,
    iban: t.company.fieldNames.iban,
    bic: t.company.fieldNames.bic,
    address: t.company.fieldNames.address,
  };
}

/** "BTW-nummer, KvK-nummer and IBAN": the fields as one phrase. */
export function listInvoiceFields(
  fields: readonly InvoiceField[],
  names: Record<InvoiceField, string>,
  separators: { comma: string; and: string },
): string {
  const words = fields.map((field) => names[field]);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(separators.comma)} ${separators.and} ${words.at(-1)}`;
}
