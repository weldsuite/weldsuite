/**
 * Backup withholding (24%) on a payment to a vendor, for the payments code to
 * call when it records a payment.
 *
 *   const bw = await computeBackupWithholding(db, { entityId, partyId, grossAmount, date });
 *   // payment.amount = grossAmount, payment.backupWithholdingAmount = bw.amount (null when 0)
 *   // posting: Dr Accounts Payable gross (the bills settle for the gross amount),
 *   //          Cr bank (gross - bw.amount), Cr `backup_withholding_payable` (bw.amount)
 *
 * It applies to reportable payments to a 1099 vendor with no TIN on file, or
 * flagged after an IRS "B" notice (`parties.backup_withholding`). It does not
 * apply to payees that are exempt (an exempt payee code on the W-9, or a
 * corporation other than an attorney), to payments by card or third-party
 * network (the processor reports those on a 1099-K), or to payments run
 * through a payroll provider. Withholding starts with the payment that brings
 * the year's total to the reporting threshold of the vendor's default box,
 * and covers that whole payment; earlier payments are not withheld
 * retroactively (`backupWithholdingDetail`).
 */

import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  FORM_1099K_PAYMENT_METHODS,
  FORM_1099_OMIT,
  form1099Thresholds,
  isAllocatableBox,
  type Form1099BoxCode,
} from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import {
  BACKUP_WITHHOLDING_RATE,
  backupWithholdingDetail,
  type BackupWithholdingReason,
} from '@weldsuite/books-domain/us-compliance/backup-withholding';
import { isCorporationClassification } from '@weldsuite/books-domain/us-compliance/form-1099-compute';
import type { PartyW9 } from './vendor-tax-data';

export interface ComputeBackupWithholdingInput {
  entityId: string;
  /** The vendor (`payments.contact_id`). */
  partyId: string;
  /** What the payment settles with the vendor, before any withholding. */
  grossAmount: number;
  date: Date | string;
  /** Card and third-party-network payments are never withheld. */
  paymentMethod?: string | null;
  paidThroughPayroll?: boolean;
  /** The money comes out of a credit-card account. */
  fromCreditCardAccount?: boolean;
}

export interface BackupWithholdingOutcome {
  /** Dollars to keep back, rounded to the cent; 0 when none applies. */
  amount: number;
  /** Why it applies; null when it does not. */
  reason: BackupWithholdingReason | null;
  rate: number;
  /** What the vendor receives: the gross amount minus `amount`. */
  net: number;
}

const NONE = (gross: number): BackupWithholdingOutcome => ({
  amount: 0,
  reason: null,
  rate: BACKUP_WITHHOLDING_RATE,
  net: gross,
});

function dayOf(date: Date | string): string {
  return typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/** The box a payment to the vendor lands in when nothing more specific says otherwise. */
function defaultBox(party: { default1099Form: string | null; default1099Box: string | null }): string | null {
  const raw = (party.default1099Box ?? '').trim().toLowerCase();
  if (raw === FORM_1099_OMIT) return FORM_1099_OMIT;
  if (/^\d+$/.test(raw) && party.default1099Form) return `${party.default1099Form}_${raw}`;
  if (raw) return raw;
  return party.default1099Form === 'nec' ? 'nec_1' : null;
}

export async function computeBackupWithholding(
  db: Database,
  input: ComputeBackupWithholdingInput,
): Promise<BackupWithholdingOutcome> {
  const gross = Math.round(input.grossAmount * 100) / 100;
  if (!(gross > 0)) return NONE(gross);

  const method = (input.paymentMethod ?? '').trim().toLowerCase();
  if (FORM_1099K_PAYMENT_METHODS.includes(method) || input.paidThroughPayroll || input.fromCreditCardAccount) {
    return NONE(gross);
  }

  const [party] = await db
    .select()
    .from(schema.parties)
    .where(and(eq(schema.parties.id, input.partyId), isNull(schema.parties.deletedAt)))
    .limit(1);
  if (!party || !party.is1099Vendor) return NONE(gross);

  const w9 = party.w9 as PartyW9 | null;
  const corporation = isCorporationClassification(w9?.federalTaxClassification, w9?.llcTaxClassification);
  const exemptPayee = Boolean(w9?.exemptPayeeCode?.trim()) || (corporation && !w9?.isAttorney);

  const box = defaultBox(party);
  if (box === FORM_1099_OMIT) return NONE(gross);

  const day = dayOf(input.date);
  const year = Number.parseInt(day.slice(0, 4), 10);
  let threshold: number | null | undefined;
  let yearToDate = 0;
  if (box && isAllocatableBox(box) && Number.isFinite(year) && year >= 2020) {
    threshold = form1099Thresholds(year).boxes[box as Form1099BoxCode];
    if (threshold !== undefined) {
      const start = new Date(Date.UTC(year, 0, 1));
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${schema.payments.amount}), 0)` })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.entityId, input.entityId),
            eq(schema.payments.type, 'sent'),
            eq(schema.payments.contactId, input.partyId),
            isNull(schema.payments.deletedAt),
            gte(schema.payments.date, start),
            lte(schema.payments.date, new Date(`${day}T23:59:59.999Z`)),
            sql`coalesce(${schema.payments.paymentMethod}, '') not in ('credit_card', 'debit_card', 'third_party_network')`,
            sql`coalesce(${schema.payments.paidThroughPayroll}, false) = false`,
          ),
        );
      yearToDate = Number(row?.total ?? 0);
    }
  }

  const result = backupWithholdingDetail(
    gross,
    { backupWithholding: party.backupWithholding, hasTin: Boolean(party.tinLast4), exemptPayee },
    { yearToDate, threshold },
  );
  return { amount: result.withheld, reason: result.reason, rate: BACKUP_WITHHOLDING_RATE, net: result.net };
}
