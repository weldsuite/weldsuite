// Client-safe types and pure helpers for the partner (reseller) screens. No
// `server-only`, no I/O: forms are kept as the strings the admin typed and
// mapped to the shared request schemas here, so the mapping is unit-testable.
// Plan: docs/plans/reseller-licensing.md. Contract: @weldsuite/app-api-client
// /schemas/partners.

import {
  PARTNER_STATUSES,
  dunningStage,
  licenceTermsSchema,
  partnerContractSchema,
  partnerProfileSchema,
  type DunningStage,
  type LicenceSnapshot,
  type PartnerContractInput,
  type PartnerContractView,
  type PartnerMemberRole,
  type PartnerProfileInput,
  type PartnerStatementView,
  type PartnerStatus,
  type LicenceTerms,
} from '@weldsuite/app-api-client/schemas/partners';
import type { ZodError } from 'zod';

// ============================================================================
// Admin route response shapes (billing-worker `/api/internal/admin/partners`)
// ============================================================================

export interface AdminPartnerListRow {
  id: string;
  name: string;
  status: PartnerStatus;
  billingEmail: string;
  workspaceCount: number;
  territories: string[];
  overdueStatementCount: number;
  createdAt: string;
}

export interface AdminPartnerRecord {
  id: string;
  name: string;
  legalName: string | null;
  country: string | null;
  taxId: string | null;
  billingEmail: string;
  supportEmail: string | null;
  supportUrl: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  stripeCustomerId: string | null;
  status: PartnerStatus;
  statusChangedAt: string | null;
  dunningPausedUntil: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface AdminPartnerMember {
  id: string;
  email: string;
  role: PartnerMemberRole;
  userId: string | null;
  acceptedAt: string | null;
  createdAt?: string;
}

export type AdminLicence = LicenceSnapshot & { startsAt?: string | null; endsAt?: string | null };

export interface AdminPartnerWorkspace {
  workspaceId: string;
  name: string;
  licence: AdminLicence | null;
}

export interface AdminPartnerDetail {
  partner: AdminPartnerRecord;
  contracts: PartnerContractView[];
  territories: string[];
  members: AdminPartnerMember[];
  workspaces: AdminPartnerWorkspace[];
  /** Newest first, without lines. */
  statements: PartnerStatementView[];
}

// ============================================================================
// Validation plumbing
// ============================================================================

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** First Zod issue as "field: message" (the path is what the admin recognises). */
export function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  const path = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

const blank = (v: string): boolean => v.trim() === '';
const nullable = (v: string): string | null => (blank(v) ? null : v.trim());
const WHOLE = /^\d+$/;

// ============================================================================
// Revenue share: the form shows percent, the contract stores basis points
// ============================================================================

/** "75" → 7500, "72.5" → 7250. Null for anything that is not 0-100 with at most 2 decimals. */
export function percentToBps(percent: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(percent.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** 7500 → "75", 7250 → "72.5". */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

// ============================================================================
// Contract form
// ============================================================================

export interface ContractFormState {
  /** `YYYY-MM-DD`, blank = now. */
  effectiveFrom: string;
  revenueSharePercent: string;
  baseMinimum: string;
  includedCredits: string;
  creditFloorPrice: string;
  extraCreditPrice: string;
  allowedFeaturePlanIds: string[];
  paymentTermsDays: string;
  pastDueAfterDays: string;
  readOnlyAfterDays: string;
  notes: string;
}

/** Contract defaults from the plan: 75% share, net 30, past due at 14, read-only at 30. */
export function defaultContractForm(): ContractFormState {
  return {
    effectiveFrom: '',
    revenueSharePercent: '75',
    baseMinimum: '',
    includedCredits: '0',
    creditFloorPrice: '0',
    extraCreditPrice: '0',
    allowedFeaturePlanIds: [],
    paymentTermsDays: '30',
    pastDueAfterDays: '14',
    readOnlyAfterDays: '30',
    notes: '',
  };
}

/** Start a new contract from the one in force, so only the changed terms are edited. */
export function contractFormFromView(view: PartnerContractView): ContractFormState {
  return {
    effectiveFrom: '',
    revenueSharePercent: bpsToPercent(view.revenueShareBps),
    baseMinimum: view.baseMinimum,
    includedCredits: String(view.includedCredits),
    creditFloorPrice: view.creditFloorPrice,
    extraCreditPrice: view.extraCreditPrice,
    allowedFeaturePlanIds: [...view.allowedFeaturePlanIds],
    paymentTermsDays: String(view.paymentTermsDays),
    pastDueAfterDays: String(view.pastDueAfterDays),
    readOnlyAfterDays: String(view.readOnlyAfterDays),
    notes: '',
  };
}

/** `YYYY-MM-DD` → ISO timestamp at 00:00 UTC; null when it is not a real date. */
export function dateToIso(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return d.toISOString();
}

/** The object the contract schema parses (also what the server action re-parses). */
export function contractPayload(form: ContractFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    currency: 'USD',
    revenueShareBps: percentToBps(form.revenueSharePercent) ?? Number.NaN,
    baseMinimum: form.baseMinimum.trim(),
    includedCredits: WHOLE.test(form.includedCredits.trim()) ? Number(form.includedCredits.trim()) : Number.NaN,
    creditFloorPrice: form.creditFloorPrice.trim() || '0',
    extraCreditPrice: form.extraCreditPrice.trim() || '0',
    allowedFeaturePlanIds: form.allowedFeaturePlanIds,
    paymentTermsDays: WHOLE.test(form.paymentTermsDays.trim()) ? Number(form.paymentTermsDays.trim()) : Number.NaN,
    pastDueAfterDays: WHOLE.test(form.pastDueAfterDays.trim()) ? Number(form.pastDueAfterDays.trim()) : Number.NaN,
    readOnlyAfterDays: WHOLE.test(form.readOnlyAfterDays.trim()) ? Number(form.readOnlyAfterDays.trim()) : Number.NaN,
    notes: nullable(form.notes),
  };
  if (!blank(form.effectiveFrom)) payload.effectiveFrom = dateToIso(form.effectiveFrom) ?? form.effectiveFrom;
  return payload;
}

export function parseContractForm(form: ContractFormState): Parsed<PartnerContractInput> {
  if (percentToBps(form.revenueSharePercent) === null) {
    return { ok: false, error: 'revenueSharePercent: a percentage between 0 and 100 (up to 2 decimals)' };
  }
  if (!blank(form.effectiveFrom) && dateToIso(form.effectiveFrom) === null) {
    return { ok: false, error: 'effectiveFrom: use a valid date (YYYY-MM-DD)' };
  }
  const result = partnerContractSchema.safeParse(contractPayload(form));
  return result.success ? { ok: true, value: result.data } : { ok: false, error: zodMessage(result.error) };
}

// ============================================================================
// Profile form
// ============================================================================

export interface ProfileFormState {
  name: string;
  legalName: string;
  country: string;
  taxId: string;
  billingEmail: string;
  supportEmail: string;
  supportUrl: string;
  websiteUrl: string;
  logoUrl: string;
}

export function emptyProfileForm(): ProfileFormState {
  return { name: '', legalName: '', country: '', taxId: '', billingEmail: '', supportEmail: '', supportUrl: '', websiteUrl: '', logoUrl: '' };
}

export function profileFormFromRecord(p: AdminPartnerRecord): ProfileFormState {
  return {
    name: p.name,
    legalName: p.legalName ?? '',
    country: p.country ?? '',
    taxId: p.taxId ?? '',
    billingEmail: p.billingEmail,
    supportEmail: p.supportEmail ?? '',
    supportUrl: p.supportUrl ?? '',
    websiteUrl: p.websiteUrl ?? '',
    logoUrl: p.logoUrl ?? '',
  };
}

/** Blank optional fields become null, so clearing a field in the form clears it on the partner. */
export function profilePayload(form: ProfileFormState): Record<string, unknown> {
  return {
    name: form.name.trim(),
    legalName: nullable(form.legalName),
    country: nullable(form.country),
    taxId: nullable(form.taxId),
    billingEmail: form.billingEmail.trim(),
    supportEmail: nullable(form.supportEmail),
    supportUrl: nullable(form.supportUrl),
    websiteUrl: nullable(form.websiteUrl),
    logoUrl: nullable(form.logoUrl),
  };
}

/** Only the fields whose value differs from the saved partner, for a PATCH. */
export function changedProfileFields(next: ProfileFormState, saved: ProfileFormState): Record<string, unknown> {
  const a = profilePayload(next);
  const b = profilePayload(saved);
  return Object.fromEntries(Object.entries(a).filter(([key, value]) => value !== b[key]));
}

export function parseProfileForm(form: ProfileFormState): Parsed<PartnerProfileInput> {
  const result = partnerProfileSchema.safeParse(profilePayload(form));
  return result.success ? { ok: true, value: result.data } : { ok: false, error: zodMessage(result.error) };
}

// ============================================================================
// Licence form (attach + admin override)
// ============================================================================

export interface LicenceFormState {
  allowedApps: string[];
  monthlyCredits: string;
  creditRolloverCap: string;
  /** Blank = unlimited. */
  maxSeats: string;
  /** '' = none. */
  featurePlanId: string;
  storageGb: string;
  pricingModel: 'flat' | 'per_seat';
  amount: string;
  /** Per-seat only; blank = no minimum. */
  minSeats: string;
}

export function defaultLicenceForm(): LicenceFormState {
  return {
    allowedApps: [],
    monthlyCredits: '0',
    creditRolloverCap: '0',
    maxSeats: '',
    featurePlanId: '',
    storageGb: '',
    pricingModel: 'flat',
    amount: '',
    minSeats: '',
  };
}

export function licenceFormFromSnapshot(l: LicenceSnapshot): LicenceFormState {
  return {
    allowedApps: [...l.allowedApps],
    monthlyCredits: String(l.monthlyCredits),
    creditRolloverCap: String(l.creditRolloverCap ?? 0),
    maxSeats: l.maxSeats == null ? '' : String(l.maxSeats),
    featurePlanId: l.featurePlanId ?? '',
    storageGb: l.storageGb == null ? '' : String(l.storageGb),
    pricingModel: l.resalePricing.model,
    amount: l.resalePricing.amount,
    minSeats: l.resalePricing.model === 'per_seat' && l.resalePricing.minSeats != null ? String(l.resalePricing.minSeats) : '',
  };
}

/** The object `licenceTermsSchema` parses. NaN marks an unparseable number so the schema rejects it. */
export function licencePayload(form: LicenceFormState): Record<string, unknown> {
  const int = (v: string) => (WHOLE.test(v.trim()) ? Number(v.trim()) : Number.NaN);
  const optInt = (v: string) => (blank(v) ? null : int(v));
  const resalePricing =
    form.pricingModel === 'flat'
      ? { model: 'flat', amount: form.amount.trim() }
      : {
          model: 'per_seat',
          amount: form.amount.trim(),
          ...(blank(form.minSeats) ? {} : { minSeats: int(form.minSeats) }),
        };
  return {
    allowedApps: form.allowedApps,
    monthlyCredits: int(form.monthlyCredits),
    creditRolloverCap: blank(form.creditRolloverCap) ? 0 : int(form.creditRolloverCap),
    maxSeats: optInt(form.maxSeats),
    featurePlanId: nullable(form.featurePlanId),
    storageGb: optInt(form.storageGb),
    resalePricing,
  };
}

export function parseLicenceForm(form: LicenceFormState): Parsed<LicenceTerms> {
  const result = licenceTermsSchema.safeParse(licencePayload(form));
  return result.success ? { ok: true, value: result.data } : { ok: false, error: zodMessage(result.error) };
}

// ============================================================================
// Territories
// ============================================================================

/** Upper-case, de-duplicate and sort ISO-2 codes. */
export function normalizeCountries(codes: readonly string[]): string[] {
  return [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))].sort();
}

export interface TerritoryDiff {
  added: string[];
  removed: string[];
}

export function diffTerritories(before: readonly string[], after: readonly string[]): TerritoryDiff {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((c) => !b.has(c)).sort(), removed: [...b].filter((c) => !a.has(c)).sort() };
}

/**
 * Countries named by a `TERRITORY_CONFLICT` error. The billing worker returns
 * `details.countries` as codes; tolerate `{ country }` objects too.
 */
export function territoryConflictCountries(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const countries = (details as { countries?: unknown }).countries;
  if (!Array.isArray(countries)) return [];
  const codes = countries.map((c) =>
    typeof c === 'string' ? c : c && typeof c === 'object' && typeof (c as { country?: unknown }).country === 'string'
      ? (c as { country: string }).country
      : '',
  );
  return normalizeCountries(codes);
}

/** ISO 3166-1 alpha-2 codes. Names come from `Intl.DisplayNames` where the label is rendered. */
export const COUNTRY_CODES: readonly string[] = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
];

/**
 * Shortcuts for the reseller's region. Whether Central America and the
 * Caribbean count as "North and South America" is a contract question
 * (plan, "Still open"), so they are separate buttons.
 */
export const TERRITORY_PRESETS: ReadonlyArray<{ key: 'northAmerica' | 'centralAmerica' | 'caribbean' | 'southAmerica'; countries: readonly string[] }> = [
  { key: 'northAmerica', countries: ['US', 'CA', 'MX'] },
  { key: 'centralAmerica', countries: ['BZ', 'CR', 'SV', 'GT', 'HN', 'NI', 'PA'] },
  {
    key: 'caribbean',
    countries: ['AG', 'AI', 'AW', 'BB', 'BQ', 'BS', 'CU', 'CW', 'DM', 'DO', 'GD', 'GP', 'HT', 'JM', 'KN', 'KY', 'LC', 'MF', 'MQ', 'MS', 'PR', 'SX', 'TC', 'TT', 'VC', 'VG', 'VI', 'BL'],
  },
  { key: 'southAmerica', countries: ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'] },
];

/** "NL" → "Netherlands" (falls back to the code when the runtime lacks region names). */
export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ============================================================================
// Contracts, payment standing and statement periods
// ============================================================================

/** The contract in force: the open-ended one, else the most recent. */
export function currentContract(contracts: readonly PartnerContractView[]): PartnerContractView | null {
  if (contracts.length === 0) return null;
  const open = contracts.filter((c) => c.effectiveTo === null);
  const pool = open.length > 0 ? open : contracts;
  return [...pool].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export interface OverdueStatement {
  statementId: string | null;
  periodStart: string;
  dueAt: string;
  daysOverdue: number;
  stage: DunningStage;
}

export interface PaymentOverview {
  /** Unpaid invoiced statements past their due date, oldest first. */
  overdue: OverdueStatement[];
  /** Largest `daysOverdue`, 0 when nothing is overdue. */
  maxDaysOverdue: number;
  /** The dunning stage the sweep would put the partner in, ignoring a status set by hand. */
  stage: DunningStage;
  /** True while a staff pause holds the clock. */
  paused: boolean;
}

const STAGE_RANK: Record<DunningStage, number> = { current: 0, past_due: 1, final_warning: 2, suspended: 3 };

/**
 * Overdue standing from the statement list and the contract in force, with the
 * same maths as the billing worker's dunning sweep (`dunningStage`). An
 * `invoiced` statement is unpaid; one not yet due is not overdue.
 */
export function paymentOverview(input: {
  statements: readonly Pick<PartnerStatementView, 'id' | 'status' | 'periodStart' | 'dueAt'>[];
  contract: Pick<PartnerContractView, 'pastDueAfterDays' | 'readOnlyAfterDays'> | null;
  dunningPausedUntil: string | null;
  now: Date;
}): PaymentOverview {
  const pausedUntil = input.dunningPausedUntil ? new Date(input.dunningPausedUntil) : null;
  const paused = pausedUntil !== null && !Number.isNaN(pausedUntil.getTime()) && pausedUntil.getTime() > input.now.getTime();
  const pastDueAfterDays = input.contract?.pastDueAfterDays ?? 14;
  const readOnlyAfterDays = input.contract?.readOnlyAfterDays ?? 30;

  const overdue: OverdueStatement[] = [];
  let stage: DunningStage = 'current';
  for (const s of input.statements) {
    if (s.status !== 'invoiced' || !s.dueAt) continue;
    const dueAt = new Date(s.dueAt);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() > input.now.getTime()) continue;
    const result = dunningStage({
      dueAt,
      now: input.now,
      pastDueAfterDays,
      readOnlyAfterDays,
      pausedUntil: paused ? pausedUntil : null,
    });
    overdue.push({ statementId: s.id, periodStart: s.periodStart, dueAt: s.dueAt, daysOverdue: result.daysOverdue, stage: result.stage });
    if (STAGE_RANK[result.stage] > STAGE_RANK[stage]) stage = result.stage;
  }
  overdue.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { overdue, maxDaysOverdue: overdue.reduce((m, o) => Math.max(m, o.daysOverdue), 0), stage, paused };
}

/** ISO timestamp `days` days after `now`, at the end of that UTC day. */
export function pauseUntilIso(days: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days + 1));
  return new Date(d.getTime() - 1).toISOString();
}

export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriod(value: string): boolean {
  return PERIOD.test(value);
}

/** `YYYY-MM` of the UTC month containing `date`. */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of the month before the one containing `date`. */
export function previousPeriodOf(date: Date): string {
  return periodOf(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

/** Statement statuses that `run` may rebuild (anything not paid or voided). */
export function canRunStatement(status: PartnerStatementView['status']): boolean {
  return status === 'draft' || status === 'final' || status === 'preview';
}

/** Statement statuses that can be voided. */
export function canVoidStatement(status: PartnerStatementView['status']): boolean {
  return status === 'draft' || status === 'final' || status === 'invoiced';
}

export function isPartnerStatus(value: string): value is PartnerStatus {
  return (PARTNER_STATUSES as readonly string[]).includes(value);
}
