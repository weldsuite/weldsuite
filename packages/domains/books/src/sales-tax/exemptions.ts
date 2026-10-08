/**
 * Exemption certificate resolution (docs/plans/weldbooks-us.md §6).
 *
 * A valid certificate covering the ship-to state on the document date zeroes
 * the tax; the sale still counts as gross and exempt sales on the return.
 * Validity comes from the certificate's own expiry date, else from the
 * state's rule (`us/states.ts`): Florida's annual resale certificate ends on
 * 31 December, a Washington reseller permit after 48 months, an SST blanket
 * certificate once purchases are more than 12 months apart.
 */

import { getCertificateRules, type CertificateValidityRule } from '../jurisdictions/us/states';
import { addDays, addMonths, endOfYear, isIsoDay, isoDay } from './dates';
import type { ExemptionCertificateRef } from './types';

export type CertificateFailure = 'certificate_expired' | 'certificate_missing';

export type CertificateResolution =
  | { valid: true; certificate: ExemptionCertificateRef; expiresOn: string | null }
  | {
      valid: false;
      reason: CertificateFailure;
      /** The certificate that covers the state but can't be used; absent when the customer has none for it. */
      candidate?: ExemptionCertificateRef;
    };

/** SST: a seller is protected when a complete certificate arrives within 90 days of the sale. */
export const CERTIFICATE_CURE_DAYS = 90;

/** The last day an exempt sale can be covered by a certificate received after the fact. */
export function missingCertificateCureDeadline(saleDate: string): string {
  return addDays(isoDay(saleDate), CERTIFICATE_CURE_DAYS);
}

function covers(cert: ExemptionCertificateRef, stateCode: string): boolean {
  const state = stateCode.trim().toUpperCase();
  return cert.states.some((s) => s.trim().toUpperCase() === state);
}

function ruleApplies(rule: CertificateValidityRule, cert: ExemptionCertificateRef): boolean {
  if (rule.reasons && !rule.reasons.includes(cert.reason)) return false;
  if (rule.forms && !rule.forms.includes(cert.form ?? 'state_form')) return false;
  if (rule.blanketOnly && !cert.blanket) return false;
  return true;
}

/**
 * The last valid day of a certificate in a state: its own `expiresOn`, else
 * what the state's rule gives, else null (it doesn't expire).
 */
export function certificateExpiry(cert: ExemptionCertificateRef, stateCode: string): string | null {
  if (isIsoDay(cert.expiresOn)) return isoDay(cert.expiresOn);

  for (const rule of getCertificateRules(stateCode)) {
    if (!ruleApplies(rule, cert)) continue;
    const { expiry } = rule;
    if (expiry.kind === 'calendar_year_end' && isIsoDay(cert.issuedOn)) {
      return endOfYear(cert.issuedOn);
    }
    if (expiry.kind === 'months_from_issue' && isIsoDay(cert.issuedOn)) {
      return addMonths(cert.issuedOn, expiry.months);
    }
    if (expiry.kind === 'months_from_last_purchase') {
      const base = isIsoDay(cert.lastUsedOn) ? cert.lastUsedOn : cert.issuedOn;
      if (isIsoDay(base)) return addMonths(base, expiry.months);
    }
  }
  return null;
}

type Standing = 'valid' | 'expired' | 'unusable';

function standing(
  cert: ExemptionCertificateRef,
  stateCode: string,
  date: string,
  invoiceId: string | null | undefined,
): { standing: Standing; expiresOn: string | null } {
  if (cert.status === 'revoked' || cert.status === 'pending') return { standing: 'unusable', expiresOn: null };
  if (isIsoDay(cert.issuedOn) && isoDay(cert.issuedOn) > date) return { standing: 'unusable', expiresOn: null };
  if (!cert.blanket && (!cert.invoiceId || cert.invoiceId !== invoiceId)) {
    return { standing: 'unusable', expiresOn: null };
  }
  const expiresOn = certificateExpiry(cert, stateCode);
  if (cert.status === 'expired' || (expiresOn !== null && date > expiresOn)) {
    return { standing: 'expired', expiresOn };
  }
  return { standing: 'valid', expiresOn };
}

/**
 * Find the certificate that exempts a sale to `stateCode` on `date`.
 * Single-purchase certificates only cover their own invoice.
 */
export function resolveExemptionCertificate(
  certificates: ExemptionCertificateRef[],
  opts: { stateCode: string; date: string; invoiceId?: string | null },
): CertificateResolution {
  const date = isoDay(opts.date);
  const covering = certificates.filter((c) => covers(c, opts.stateCode));

  const valid: Array<{ cert: ExemptionCertificateRef; expiresOn: string | null; specific: boolean }> = [];
  let expired: ExemptionCertificateRef | undefined;
  for (const cert of covering) {
    const s = standing(cert, opts.stateCode, date, opts.invoiceId);
    if (s.standing === 'valid') {
      valid.push({ cert, expiresOn: s.expiresOn, specific: !cert.blanket });
    } else if (s.standing === 'expired' && !expired) {
      expired = cert;
    }
  }

  if (valid.length > 0) {
    // The certificate made for this invoice first, then the one that lasts longest.
    valid.sort((a, b) => {
      if (a.specific !== b.specific) return a.specific ? -1 : 1;
      const ea = a.expiresOn ?? '9999-12-31';
      const eb = b.expiresOn ?? '9999-12-31';
      return ea < eb ? 1 : ea > eb ? -1 : 0;
    });
    return { valid: true, certificate: valid[0].cert, expiresOn: valid[0].expiresOn };
  }
  if (expired) return { valid: false, reason: 'certificate_expired', candidate: expired };
  if (covering.length > 0) return { valid: false, reason: 'certificate_missing', candidate: covering[0] };
  return { valid: false, reason: 'certificate_missing' };
}
