/**
 * Backup withholding (24%) on payments to vendors without a valid TIN, and the
 * Form 945 annual summary of what was withheld.
 *
 * Backup withholding applies when the payee gave no TIN, or the IRS notified
 * the payer of an incorrect name/TIN (CP2100 / "B" notice, withholding starts
 * 30 business days after the notice is received), or the payee failed to
 * certify, or the IRS ordered it for underreporting. The vendor's
 * `backupWithholding` flag records those; `hasTin: false` also triggers it.
 */

import { form1099Deadlines } from '../jurisdictions/us/form-1099';
import { formatIso, parseIso } from './dates';
import { rollToBusinessDay } from './federal-holidays';
import { toCents } from './form-1099-compute';

export const BACKUP_WITHHOLDING_RATE = 0.24;

export interface BackupWithholdingVendor {
  /** The IRS notified an incorrect TIN, or the payee failed to certify, or the IRS ordered withholding. */
  backupWithholding?: boolean | null;
  /** False when no TIN is on file; the payer then has to withhold. Unknown (undefined) counts as present. */
  hasTin?: boolean | null;
  /** The W-9 carries an exempt payee code: not subject to backup withholding. */
  exemptPayee?: boolean | null;
}

export type BackupWithholdingReason = 'no_tin' | 'flagged';

export interface BackupWithholdingOptions {
  /** Payments to the vendor earlier in the year. */
  yearToDate?: number;
  /**
   * Reporting threshold of the box the payment lands in. Withholding starts with
   * the payment that brings the year's total to the threshold and covers that
   * whole payment; nothing is withheld retroactively on earlier ones.
   */
  threshold?: number | null;
}

export interface BackupWithholdingResult {
  applies: boolean;
  reason: BackupWithholdingReason | null;
  /** Dollars to keep back, rounded to the cent. */
  withheld: number;
  /** What the vendor receives: the amount minus the withheld part. */
  net: number;
}

/** Why the vendor is subject to backup withholding, or null. */
export function backupWithholdingReason(vendor: BackupWithholdingVendor): BackupWithholdingReason | null {
  if (vendor.exemptPayee) return null;
  if (vendor.hasTin === false) return 'no_tin';
  if (vendor.backupWithholding) return 'flagged';
  return null;
}

export function backupWithholdingDetail(
  amount: number,
  vendor: BackupWithholdingVendor,
  options: BackupWithholdingOptions = {},
): BackupWithholdingResult {
  const gross = toCents(amount);
  const reason = backupWithholdingReason(vendor);
  const reportable =
    options.threshold === undefined || options.threshold === null
      ? true
      : toCents(options.yearToDate ?? 0) + gross >= toCents(options.threshold);
  if (!reason || gross <= 0 || !reportable) {
    return { applies: false, reason: null, withheld: 0, net: gross / 100 };
  }
  // 24% in whole cents, half a cent rounded up.
  const withheldCents = Math.floor((gross * 24 + 50) / 100);
  return { applies: true, reason, withheld: withheldCents / 100, net: (gross - withheldCents) / 100 };
}

/** The amount to withhold from a payment to the vendor, in dollars rounded to the cent (0 when none applies). */
export function backupWithholdingFor(
  amount: number,
  vendor: BackupWithholdingVendor,
  options: BackupWithholdingOptions = {},
): number {
  return backupWithholdingDetail(amount, vendor, options).withheld;
}

// Form 945

export interface Form945Payment {
  id: string;
  partyId: string;
  /** `YYYY-MM-DD` */
  date: string;
  backupWithholdingAmount?: number | null;
  voided?: boolean;
}

export interface Form945Month {
  month: number;
  /** Tax liability of the month (Form 945 monthly summary). */
  amount: number;
  /** Monthly schedule depositors deposit by the 15th of the following month, moved to a business day. */
  depositDue: string;
}

export interface Form945Summary {
  taxYear: number;
  /** Form 945 line 2: backup withholding. */
  backupWithholding: number;
  /** Line 1 (pensions, annuities, gambling) is not tracked here, so line 3 equals line 2. */
  totalTaxes: number;
  months: Form945Month[];
  byVendor: Array<{ partyId: string; amount: number; paymentIds: string[] }>;
  /** Due 31 January of the next year, moved to a business day. */
  dueDate: string;
}

/** Annual summary of backup withholding for Form 945, from the payments of a calendar year. */
export function form945Summary(taxYear: number, payments: Form945Payment[]): Form945Summary {
  const monthCents = new Array<number>(12).fill(0);
  const vendors = new Map<string, { cents: number; paymentIds: string[] }>();
  let total = 0;

  for (const payment of payments) {
    const cents = toCents(payment.backupWithholdingAmount ?? 0);
    if (cents === 0 || payment.voided) continue;
    const { y, m } = parseIso(payment.date);
    if (y !== taxYear) continue;
    monthCents[m - 1] = (monthCents[m - 1] ?? 0) + cents;
    total += cents;
    const entry = vendors.get(payment.partyId) ?? { cents: 0, paymentIds: [] };
    entry.cents += cents;
    entry.paymentIds.push(payment.id);
    vendors.set(payment.partyId, entry);
  }

  const months = monthCents.map((cents, index) => ({
    month: index + 1,
    amount: cents / 100,
    depositDue: rollToBusinessDay(index === 11 ? formatIso(taxYear + 1, 1, 15) : formatIso(taxYear, index + 2, 15)),
  }));

  return {
    taxYear,
    backupWithholding: total / 100,
    totalTaxes: total / 100,
    months,
    byVendor: [...vendors.entries()].map(([partyId, entry]) => ({
      partyId,
      amount: entry.cents / 100,
      paymentIds: entry.paymentIds,
    })),
    dueDate: form1099Deadlines(taxYear).form945,
  };
}
