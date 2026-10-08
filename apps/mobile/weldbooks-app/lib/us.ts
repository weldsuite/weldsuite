/**
 * US specifics the forms need: USPS state codes, ZIP and EIN checks, and the
 * product tax codes a US invoice line is taxed under.
 *
 * The app doesn't import `@weldsuite/books-domain` (server code), so the rules
 * mirror `packages/domains/books/src/jurisdictions/us/` — books-api checks
 * every value again, so these only catch typos before a request is sent.
 */

import type { PostalAddress, UsEntityTypeOption } from '@/types/accounting';

/** The 50 states plus DC, then the territories, keyed by their USPS code. Names are proper nouns. */
export const US_STATES: readonly { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'GU', name: 'Guam' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
];

const US_STATE_CODES = new Set(US_STATES.map((state) => state.code));

export function isUsStateCode(value: string | null | undefined): boolean {
  return !!value && US_STATE_CODES.has(value.trim().toUpperCase());
}

/**
 * Map what a user (or an older record) typed to a USPS code: "ca", "CA" and
 * "California" all become "CA". Anything unrecognised comes back trimmed, so
 * nothing typed is lost.
 */
export function toUsStateCode(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  const upper = trimmed.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  const byName = US_STATES.find((state) => state.name.toUpperCase() === upper);
  return byName ? byName.code : trimmed;
}

/** Options for a state picker. */
export const US_STATE_OPTIONS: readonly { label: string; value: string }[] = US_STATES.map((state) => ({
  label: `${state.name} (${state.code})`,
  value: state.code,
}));

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/** `12345`, `12345-6789` or nine digits → the canonical form, or null. ZIP codes are text: leading zeros survive. */
export function normalizeZip(value: string | null | undefined): string | null {
  const match = /^(\d{5})(?:-?(\d{4}))?$/.exec((value ?? '').trim());
  if (!match || match[1] === '00000') return null;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

/** Digits and the ZIP+4 hyphen only, as the user types. */
export function formatZipInput(value: string): string {
  const digits = value.replaceAll(/\D/g, '').slice(0, 9);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

// ---------------------------------------------------------------------------
// EIN
// ---------------------------------------------------------------------------

/** Prefixes (first two digits) the IRS assigns, as inclusive ranges. */
const EIN_VALID_PREFIX_RANGES: readonly (readonly [number, number])[] = [
  [1, 6],
  [10, 16],
  [20, 27],
  [30, 48],
  [50, 68],
  [71, 77],
  [80, 88],
  [90, 95],
  [98, 99],
];

/** Format what the user has typed so far as `XX-XXXXXXX`. */
export function formatEinInput(value: string): string {
  const digits = value.replaceAll(/\D/g, '').slice(0, 9);
  return digits.length > 2 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : digits;
}

/** `null` when the EIN is acceptable (or empty), else why it isn't. */
export function einProblem(value: string): 'format' | 'prefix' | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{2}-\d{7}$/.test(trimmed) && !/^\d{9}$/.test(trimmed)) return 'format';
  const prefix = Number.parseInt(trimmed.replaceAll(/\D/g, '').slice(0, 2), 10);
  return EIN_VALID_PREFIX_RANGES.some(([from, to]) => prefix >= from && prefix <= to) ? null : 'prefix';
}

/** Canonical `XX-XXXXXXX` form of an EIN the user typed. */
export function normalizeEin(value: string): string {
  const digits = value.replaceAll(/\D/g, '');
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : value.trim();
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const EMPTY_ADDRESS: Required<Pick<PostalAddress, 'line1' | 'line2' | 'city' | 'state' | 'postalCode'>> = {
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
};

/** The editable parts of a US address, as the form keeps them (text, never undefined). */
export type AddressDraft = typeof EMPTY_ADDRESS;

/** An address row in either stored shape → the form's draft. */
export function toAddressDraft(address: PostalAddress | null | undefined): AddressDraft {
  return {
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    city: address?.city ?? '',
    state: toUsStateCode(address?.state),
    postalCode: address?.postalCode ?? '',
  };
}

export function isAddressBlank(draft: AddressDraft): boolean {
  return Object.values(draft).every((part) => part.trim() === '');
}

/**
 * A ship-to the sales tax engine can work with: a real state and a ZIP.
 * (books-api refuses to finalize a US invoice without one: `ADDRESS_REQUIRED`.)
 */
export function isUsAddressTaxable(draft: Pick<AddressDraft, 'state' | 'postalCode'>): boolean {
  return isUsStateCode(draft.state) && normalizeZip(draft.postalCode) !== null;
}

/** What is wrong with a US address, by field; empty when it is fine (a blank address is fine). */
export function usAddressProblems(
  draft: AddressDraft,
  options: { requireStateAndZip?: boolean } = {},
): { state?: 'required' | 'invalid'; postalCode?: 'required' | 'invalid' } {
  const problems: { state?: 'required' | 'invalid'; postalCode?: 'required' | 'invalid' } = {};
  const blank = isAddressBlank(draft);
  const mustHave = options.requireStateAndZip || !blank;

  if (!draft.state.trim()) {
    if (mustHave) problems.state = 'required';
  } else if (!isUsStateCode(draft.state)) {
    problems.state = 'invalid';
  }

  if (!draft.postalCode.trim()) {
    if (mustHave) problems.postalCode = 'required';
  } else if (normalizeZip(draft.postalCode) === null) {
    problems.postalCode = 'invalid';
  }
  return problems;
}

/** The address as the API takes it: trimmed, blank parts dropped, `US` as the country. Null for a blank address. */
export function toApiAddress(draft: AddressDraft): PostalAddress | null {
  if (isAddressBlank(draft)) return null;
  const out: PostalAddress = { country: 'US' };
  const line1 = draft.line1.trim();
  const line2 = draft.line2.trim();
  const city = draft.city.trim();
  const state = toUsStateCode(draft.state);
  const zip = normalizeZip(draft.postalCode) ?? draft.postalCode.trim();
  if (line1) out.line1 = line1;
  if (line2) out.line2 = line2;
  if (city) out.city = city;
  if (state) out.state = state;
  if (zip) out.postalCode = zip;
  return out;
}

/** "Springfield, IL 62704" — the city line of an address. */
export function cityLine(address: PostalAddress | null | undefined): string {
  if (!address) return '';
  const stateZip = [address.state, address.postalCode].filter(Boolean).join(' ');
  return [address.city, stateZip].filter(Boolean).join(', ');
}

/** The lines of an address to print, top to bottom. */
export function addressLines(address: PostalAddress | null | undefined): string[] {
  if (!address) return [];
  return [address.line1, address.line2, cityLine(address)].filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------
// Product tax codes
// ---------------------------------------------------------------------------

/**
 * The WeldBooks product tax codes a US invoice (or bill) line can carry
 * (`packages/domains/books/src/jurisdictions/us/tax-codes.ts`).
 */
export const WELD_TAX_CODES = [
  'general',
  'saas',
  'digital_goods',
  'services',
  'professional_services',
  'shipping',
  'handling',
  'food_grocery',
  'prepared_food',
  'clothing',
  'prescription_drugs',
  'non_taxable',
] as const;

export type WeldTaxCode = (typeof WELD_TAX_CODES)[number];

/** The code a line gets when none is chosen: taxable as general goods. */
export const DEFAULT_TAX_CODE: WeldTaxCode = 'general';

export function isWeldTaxCode(value: unknown): value is WeldTaxCode {
  return typeof value === 'string' && (WELD_TAX_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Legal forms
// ---------------------------------------------------------------------------

const FORM_BY_CLASSIFICATION: Record<string, { form: string; formLabel: string }> = {
  sole_proprietor: { form: 'sch_c', formLabel: 'Schedule C (Form 1040)' },
  disregarded: { form: 'sch_c', formLabel: 'Schedule C (Form 1040)' },
  partnership: { form: 'f1065', formLabel: 'Form 1065' },
  s_corp: { form: 'f1120s', formLabel: 'Form 1120-S' },
  c_corp: { form: 'f1120', formLabel: 'Form 1120' },
  exempt: { form: 'f990', formLabel: 'Form 990' },
};

function entityType(type: string, classifications: string[], minOwners: 1 | 2): UsEntityTypeOption {
  return {
    type,
    label: type,
    description: '',
    minOwners,
    defaultClassification: classifications[0],
    classifications: classifications.map((value) => ({ value, ...FORM_BY_CLASSIFICATION[value] })),
  };
}

/**
 * The legal forms of a US entity with the tax classifications each may have
 * (`jurisdictions/us/entity-types.ts`). The jurisdiction list from the API
 * carries the same; this answers until it has loaded.
 */
export const FALLBACK_US_ENTITY_TYPES: readonly UsEntityTypeOption[] = [
  entityType('sole_proprietorship', ['sole_proprietor'], 1),
  entityType('single_member_llc', ['disregarded', 's_corp', 'c_corp'], 1),
  entityType('multi_member_llc', ['partnership', 's_corp', 'c_corp'], 2),
  entityType('partnership', ['partnership'], 2),
  entityType('s_corp', ['s_corp'], 1),
  entityType('c_corp', ['c_corp'], 1),
  entityType('nonprofit', ['exempt'], 1),
];

/** The legal forms to offer: the API's list, else the built-in one. */
export function usEntityTypes(loaded: readonly UsEntityTypeOption[] | undefined): readonly UsEntityTypeOption[] {
  return loaded && loaded.length > 0 ? loaded : FALLBACK_US_ENTITY_TYPES;
}

/** The tax classification a legal form starts with, or its only one. */
export function defaultClassificationOf(
  types: readonly UsEntityTypeOption[],
  type: string,
): string {
  const found = types.find((candidate) => candidate.type === type);
  return found?.defaultClassification || found?.classifications[0]?.value || '';
}

/** `value` when the legal form allows it, else the form's default (what the server does on a change). */
export function validClassification(
  types: readonly UsEntityTypeOption[],
  type: string,
  value: string | null | undefined,
): string {
  const allowed = types.find((candidate) => candidate.type === type)?.classifications ?? [];
  return value && allowed.some((option) => option.value === value) ? value : defaultClassificationOf(types, type);
}
