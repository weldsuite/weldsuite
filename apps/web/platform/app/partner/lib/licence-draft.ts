/**
 * The licence editor's form state, kept as plain strings (what the inputs
 * hold) and converted to the request body only on submit. The conversion and
 * the live "WeldSuite bills / you keep" figures are pure, so the maths shown
 * on screen is exactly `priceWorkspaceMonth`, the function the statement run
 * uses.
 */

import {
  priceWorkspaceMonth,
  toCents,
  workspaceLicenceInputSchema,
  type LicenceSnapshot,
  type PricingContract,
  type ResalePricing,
  type WorkspaceMonthPrice,
} from '@weldsuite/app-api-client/schemas/partners';
import type {
  PartnerLicencePackage,
  WorkspaceLicenceBody,
} from '@weldsuite/app-api-client/domains/partners';

export interface LicenceDraft {
  packageId: string | null;
  allowedApps: string[];
  monthlyCredits: string;
  creditRolloverCap: string;
  /** Empty = unlimited. */
  maxSeats: string;
  featurePlanId: string | null;
  /** Empty = not recorded. */
  storageGb: string;
  pricingModel: ResalePricing['model'];
  amount: string;
  /** Per-seat only. Empty = none. */
  minSeats: string;
  reason: string;
}

export type LicenceDraftField =
  | 'allowedApps'
  | 'monthlyCredits'
  | 'creditRolloverCap'
  | 'maxSeats'
  | 'storageGb'
  | 'amount'
  | 'minSeats';

/** Keys of `partner.licence` that hold the message for a field. */
export type LicenceErrorKey = 'invalid' | 'invalidAmount' | 'invalidCredits' | 'invalidSeats';
export type LicenceDraftErrors = Partial<Record<LicenceDraftField, LicenceErrorKey>>;

export function emptyDraft(): LicenceDraft {
  return {
    packageId: null,
    allowedApps: [],
    monthlyCredits: '0',
    creditRolloverCap: '0',
    maxSeats: '',
    featurePlanId: null,
    storageGb: '',
    pricingModel: 'flat',
    amount: '',
    minSeats: '',
    reason: '',
  };
}

function numberOrEmpty(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function pricingFields(pricing: ResalePricing): Pick<LicenceDraft, 'pricingModel' | 'amount' | 'minSeats'> {
  return {
    pricingModel: pricing.model,
    amount: pricing.amount,
    minSeats: pricing.model === 'per_seat' ? numberOrEmpty(pricing.minSeats) : '',
  };
}

export function draftFromLicence(licence: LicenceSnapshot): LicenceDraft {
  return {
    packageId: licence.packageId,
    allowedApps: [...licence.allowedApps],
    monthlyCredits: String(licence.monthlyCredits),
    creditRolloverCap: String(licence.creditRolloverCap ?? 0),
    maxSeats: numberOrEmpty(licence.maxSeats),
    featurePlanId: licence.featurePlanId,
    storageGb: numberOrEmpty(licence.storageGb),
    ...pricingFields(licence.resalePricing),
    reason: '',
  };
}

export function draftFromPackage(pkg: PartnerLicencePackage): LicenceDraft {
  return {
    packageId: pkg.id,
    allowedApps: [...pkg.allowedApps],
    monthlyCredits: String(pkg.monthlyCredits),
    creditRolloverCap: '0',
    maxSeats: numberOrEmpty(pkg.maxSeats),
    featurePlanId: pkg.featurePlanId,
    storageGb: numberOrEmpty(pkg.storageGb),
    ...pricingFields(pkg.defaultResalePricing),
    reason: '',
  };
}

const WHOLE_NUMBER = /^\d+$/;

function wholeNumber(value: string): number {
  const trimmed = value.trim();
  return WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function optionalWholeNumber(value: string): number | null {
  return value.trim() === '' ? null : wholeNumber(value);
}

function resalePricingOf(draft: LicenceDraft): unknown {
  const amount = draft.amount.trim();
  if (draft.pricingModel === 'flat') return { model: 'flat', amount };
  const minSeats = optionalWholeNumber(draft.minSeats);
  return { model: 'per_seat', amount, ...(minSeats === null ? {} : { minSeats }) };
}

const FIELD_ERROR: Record<LicenceDraftField, LicenceErrorKey> = {
  allowedApps: 'invalid',
  monthlyCredits: 'invalidCredits',
  creditRolloverCap: 'invalidCredits',
  maxSeats: 'invalidSeats',
  storageGb: 'invalidSeats',
  amount: 'invalidAmount',
  minSeats: 'invalidSeats',
};

function fieldOfIssue(path: ReadonlyArray<string | number>): LicenceDraftField | null {
  const [head, tail] = path;
  if (head === 'resalePricing') {
    if (tail === 'amount') return 'amount';
    if (tail === 'minSeats') return 'minSeats';
    return 'amount';
  }
  if (typeof head === 'string' && head in FIELD_ERROR) return head as LicenceDraftField;
  return null;
}

export type ParsedDraft =
  | { ok: true; value: WorkspaceLicenceBody }
  | { ok: false; errors: LicenceDraftErrors };

/** Validate the draft with the same schema the server uses. */
export function parseDraft(draft: LicenceDraft): ParsedDraft {
  const candidate = {
    packageId: draft.packageId,
    allowedApps: draft.allowedApps,
    monthlyCredits: wholeNumber(draft.monthlyCredits),
    creditRolloverCap: wholeNumber(draft.creditRolloverCap === '' ? '0' : draft.creditRolloverCap),
    maxSeats: optionalWholeNumber(draft.maxSeats),
    featurePlanId: draft.featurePlanId,
    storageGb: optionalWholeNumber(draft.storageGb),
    resalePricing: resalePricingOf(draft),
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
  };

  const result = workspaceLicenceInputSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };

  const errors: LicenceDraftErrors = {};
  for (const issue of result.error.issues) {
    const field = fieldOfIssue(issue.path);
    if (field && !errors[field]) errors[field] = FIELD_ERROR[field];
  }
  return { ok: false, errors };
}

/**
 * The monthly estimate for a draft, or null while the draft is not yet a valid
 * price (a half-typed amount must not flash NaN).
 */
export function previewDraft(
  contract: PricingContract | null | undefined,
  draft: LicenceDraft,
  seats: number,
): WorkspaceMonthPrice | null {
  if (!contract) return null;
  const credits = wholeNumber(draft.monthlyCredits);
  if (!Number.isFinite(credits)) return null;
  const amount = draft.amount.trim();
  try {
    toCents(amount);
  } catch {
    return null;
  }
  const minSeats = optionalWholeNumber(draft.minSeats);
  const resalePricing: ResalePricing =
    draft.pricingModel === 'flat'
      ? { model: 'flat', amount }
      : { model: 'per_seat', amount, ...(minSeats !== null && Number.isFinite(minSeats) ? { minSeats } : {}) };
  return priceWorkspaceMonth(contract, { monthlyCredits: credits, resalePricing }, Math.max(0, Math.floor(seats)));
}
