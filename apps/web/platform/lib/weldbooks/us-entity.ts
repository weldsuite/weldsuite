/**
 * US entity setup helpers: the shape of the US entry of
 * `GET /api/accounting-entities/jurisdictions`, client-side checks of the EIN
 * and SSN (the server checks them again), and the time zones a US entity can
 * use. The platform doesn't import `@weldsuite/books-domain`, so the rules
 * mirror `jurisdictions/us/identifiers.ts` and `accounting-entity-setup.ts`.
 */

export type UsAccountingMethod = 'accrual' | 'cash';

export interface UsTaxClassificationOption {
  value: string;
  /** Return form code, e.g. `f1120s`. */
  form: string;
  /** Return form as printed, e.g. `Form 1120-S`. */
  formLabel: string;
}

/** One entry of `entityTypes` on the US jurisdiction. */
export interface UsEntityTypeSummary {
  type: string;
  /** English label from the server; the UI prefers its own translation. */
  label: string;
  description: string;
  minOwners: number;
  defaultClassification: string;
  classifications: UsTaxClassificationOption[];
}

export function isUsJurisdictionCode(code: string | null | undefined): boolean {
  return code?.toUpperCase() === 'US';
}

/** The classification options of an entity type; empty for an unknown type. */
export function classificationsOf(
  entityTypes: readonly UsEntityTypeSummary[] | undefined,
  entityType: string | null | undefined,
): UsTaxClassificationOption[] {
  return entityTypes?.find((t) => t.type === entityType)?.classifications ?? [];
}

/** The classification a type starts with, or the first allowed one. */
export function defaultClassificationOf(
  entityTypes: readonly UsEntityTypeSummary[] | undefined,
  entityType: string | null | undefined,
): string {
  const summary = entityTypes?.find((t) => t.type === entityType);
  return summary?.defaultClassification ?? summary?.classifications[0]?.value ?? '';
}

/** `value` when the type allows it, else the type's default (what the server does on a type change). */
export function validClassification(
  entityTypes: readonly UsEntityTypeSummary[] | undefined,
  entityType: string | null | undefined,
  value: string | null | undefined,
): string {
  const allowed = classificationsOf(entityTypes, entityType);
  if (value && allowed.some((c) => c.value === value)) return value;
  return defaultClassificationOf(entityTypes, entityType);
}

// ---------------------------------------------------------------------------
// EIN
// ---------------------------------------------------------------------------

/** Prefixes (first two digits) the IRS assigns, as inclusive ranges. */
const EIN_VALID_PREFIX_RANGES: ReadonlyArray<readonly [number, number]> = [
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

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** Format what the user has typed so far as `XX-XXXXXXX`. */
export function formatEinInput(value: string): string {
  const digits = digitsOf(value).slice(0, 9);
  return digits.length > 2 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : digits;
}

export type TaxIdProblem = 'format' | 'prefix' | 'area' | 'group' | 'serial';

/** `null` when the EIN is acceptable (or empty). */
export function einProblem(value: string): TaxIdProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{2}-\d{7}$/.test(trimmed) && !/^\d{9}$/.test(trimmed)) return 'format';
  const prefix = Number.parseInt(digitsOf(trimmed).slice(0, 2), 10);
  return EIN_VALID_PREFIX_RANGES.some(([from, to]) => prefix >= from && prefix <= to) ? null : 'prefix';
}

/** Canonical `XX-XXXXXXX` form of an EIN the user typed. */
export function normalizeEin(value: string): string {
  const digits = digitsOf(value);
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : value.trim();
}

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

/** Format what the user has typed so far as `XXX-XX-XXXX`. */
export function formatSsnInput(value: string): string {
  const digits = digitsOf(value).slice(0, 9);
  if (digits.length > 5) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  if (digits.length > 3) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return digits;
}

const VOIDED_SSNS: ReadonlySet<string> = new Set(['078051120', '219099999']);

/** `null` when the SSN is acceptable (or empty). */
export function ssnProblem(value: string): TaxIdProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{3}-\d{2}-\d{4}$/.test(trimmed) && !/^\d{9}$/.test(trimmed)) return 'format';
  const digits = digitsOf(trimmed);
  const area = Number.parseInt(digits.slice(0, 3), 10);
  if (area === 0 || area === 666 || area >= 900 || VOIDED_SSNS.has(digits)) return 'area';
  if (digits.slice(3, 5) === '00') return 'group';
  if (digits.slice(5) === '0000') return 'serial';
  return null;
}

/** Canonical `XXX-XX-XXXX` form of an SSN the user typed. */
export function normalizeSsn(value: string): string {
  const digits = digitsOf(value);
  return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : value.trim();
}

/** `•••-••-1234` for an SSN of which only the last four digits are known. */
export function maskedSsn(last4: string | null | undefined): string {
  return `•••-••-${last4 && /^\d{4}$/.test(last4) ? last4 : '••••'}`;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** IANA zones used by US states and territories, most common first. */
export const US_TIME_ZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Boise',
  'America/Puerto_Rico',
  'America/St_Thomas',
  'Pacific/Guam',
  'Pacific/Pago_Pago',
  'Pacific/Saipan',
];

/** Primary zone of each state and territory (mirrors the server's default for a new US entity). */
const STATE_TIME_ZONES: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam', AS: 'Pacific/Pago_Pago', MP: 'Pacific/Saipan',
};

export function defaultUsTimeZone(state: string | null | undefined): string {
  return (state && STATE_TIME_ZONES[state.toUpperCase()]) || 'America/New_York';
}

/** The zones to offer: the US list, plus the entity's current one when it is something else. */
export function timeZoneOptions(current?: string | null): string[] {
  return current && !US_TIME_ZONES.includes(current) ? [...US_TIME_ZONES, current] : [...US_TIME_ZONES];
}
