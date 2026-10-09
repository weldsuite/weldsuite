/**
 * Pieces every sales tax engine shares: the registration rule, untaxed
 * results, hand-set tax overrides.
 */

import type { PostalAddress } from '@weldsuite/db/schema';
import { getUsState } from '../jurisdictions/us/states';
import { inRange, isoDay } from './dates';
import { resolveExemptionCertificate } from './exemptions';
import { allocateCents, fromCents, snap6, toCents } from './rounding';
import type {
  ExemptionCertificateRef,
  SalesTaxDetail,
  SalesTaxEngineId,
  SalesTaxLineResult,
  SalesTaxRegistration,
  SalesTaxRequest,
  SalesTaxRequestLine,
  SalesTaxResult,
  SalesTaxWarning,
} from './types';

export function isRegistrationActive(reg: SalesTaxRegistration, date: string): boolean {
  return reg.status === 'registered' && inRange(isoDay(date), reg.registeredFrom, reg.registeredUntil);
}

/** Registrations in force for a state on a date; tax is charged only under these. */
export function activeRegistrations(
  registrations: SalesTaxRegistration[],
  stateCode: string,
  date: string,
): SalesTaxRegistration[] {
  const state = stateCode.trim().toUpperCase();
  return registrations.filter(
    (r) => r.stateCode.trim().toUpperCase() === state && isRegistrationActive(r, date),
  );
}

/** States with no state or local sales tax at all (DE, MT, NH, OR): nothing to register for. */
export function stateHasNoSalesTax(stateCode: string): boolean {
  const info = getUsState(stateCode);
  return Boolean(info && !info.hasStateSalesTax && !info.hasLocalSalesTax);
}

export function isUsCountry(address: PostalAddress | null | undefined): boolean {
  const country = address?.country?.trim().toUpperCase();
  return !country || country === 'US' || country === 'USA' || country === 'UNITED STATES';
}

/** A line nothing was charged on: it still counts as a sale, so its amount shows as non-taxable. */
export function untaxedLine(line: SalesTaxRequestLine): SalesTaxLineResult {
  const gross = fromCents(toCents(line.amount));
  return {
    lineId: line.lineId,
    grossAmount: gross,
    taxableAmount: 0,
    exemptAmount: 0,
    nonTaxableAmount: gross,
    tax: 0,
    details: [],
  };
}

export function buildResult(
  engine: SalesTaxEngineId | (string & {}),
  req: SalesTaxRequest,
  fields: {
    sourcing: SalesTaxResult['sourcing'];
    lines: SalesTaxLineResult[];
    warnings: Iterable<SalesTaxWarning>;
    engineRef?: string;
    shipToState?: string;
    calculatedAt: string;
  },
): SalesTaxResult {
  const totalCents = fields.lines.reduce((sum, l) => sum + toCents(l.tax), 0);
  const postalCode = req.shipTo?.postalCode?.trim();
  return {
    engine,
    ...(fields.engineRef ? { engineRef: fields.engineRef } : {}),
    calculatedAt: fields.calculatedAt,
    sourcing: fields.sourcing,
    ...(fields.shipToState ? { shipToState: fields.shipToState } : {}),
    ...(postalCode ? { shipToPostalCode: postalCode } : {}),
    lines: fields.lines,
    totalTax: fromCents(totalCents),
    warnings: [...new Set(fields.warnings)],
  };
}

export function untaxedResult(
  engine: SalesTaxEngineId | (string & {}),
  req: SalesTaxRequest,
  warnings: SalesTaxWarning[],
  calculatedAt: string,
  shipToState?: string,
): SalesTaxResult {
  return buildResult(engine, req, {
    sourcing: 'none',
    lines: req.lines.map(untaxedLine),
    warnings,
    shipToState,
    calculatedAt,
  });
}

/**
 * Spread a whole-cent tax total over weights: the unrounded tax per
 * jurisdiction, or the rates when nothing was computed (an override on an
 * exempt line), so the parts add up exactly.
 */
export function spreadTax(totalCents: number, unrounded: number[], rates: number[]): number[] {
  const byTax = unrounded.reduce((s, x) => s + Math.abs(x), 0);
  return allocateCents(totalCents, byTax > 0 ? unrounded : rates);
}

/**
 * Keep the user's tax on a line (spread pro rata over the jurisdictions) and
 * flag it. Returns the line unchanged when there is no jurisdiction to carry it.
 */
export function applyOverride(
  line: SalesTaxLineResult,
  override: { amount: number; reason: string },
): { line: SalesTaxLineResult; applied: boolean } {
  if (line.details.length === 0) return { line, applied: false };
  const total = toCents(override.amount);
  const parts = spreadTax(
    total,
    line.details.map((d) => d.unroundedTax),
    line.details.map((d) => d.rate),
  );
  const details: SalesTaxDetail[] = line.details.map((d, i) => ({
    ...d,
    tax: fromCents(parts[i]),
    unroundedTax: snap6(fromCents(parts[i])),
  }));
  return {
    applied: true,
    line: { ...line, details, tax: fromCents(total), overridden: true, overrideReason: override.reason },
  };
}

/** The certificate that exempts this sale, or the warning explaining why none does. */
export function certificateForSale(
  req: SalesTaxRequest,
  stateCode: string,
  date: string,
): { certificate?: ExemptionCertificateRef; warning?: SalesTaxWarning } {
  if (req.customer.certificates.length === 0) return {};
  const resolution = resolveExemptionCertificate(req.customer.certificates, {
    stateCode,
    date,
    invoiceId: req.documentId,
  });
  if (resolution.valid) return { certificate: resolution.certificate };
  return resolution.candidate ? { warning: resolution.reason } : {};
}

const LEVEL_ABBR: Record<string, string> = { state: 'ST', county: 'CTY', city: 'CIT', district: 'DIS' };

function hash36(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0');
}

/**
 * A stable jurisdiction code for engines that don't send one (Stripe), short
 * enough for `tax_lines.jurisdiction_code` (30 characters).
 */
export function jurisdictionCodeFor(stateCode: string, level: string, name: string, discriminator?: string): string {
  const slug = `${name}${discriminator ? `-${discriminator}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const code = `${stateCode.toUpperCase()}-${LEVEL_ABBR[level] ?? level.toUpperCase()}-${slug}`;
  return code.length <= 30 ? code : `${code.slice(0, 21)}-${hash36(code)}`;
}
