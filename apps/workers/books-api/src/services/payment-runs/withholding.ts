/**
 * Backup withholding on the vendors of a payment run.
 *
 * A run takes the 24% out of the payment itself: the vendor's payment settles
 * its bills for the gross amount, the bank is credited the net and the withheld
 * part is credited to Backup Withholding Payable (`recordPayment`,
 * services/accounting-payments.ts). Whether and how much to withhold is
 * `computeBackupWithholding` (services/backup-withholding.ts), per vendor and
 * payment, with the year-to-date threshold of the vendor's 1099 box.
 *
 * The figures in a draft or pending run are a preview: the amount that counts
 * is the one worked out when the payment is made at the last approval, and
 * after that the one stored on the payment.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountForRole, loadEntityAccounts, roundMoney } from '../accounting-posting';
import { computeBackupWithholding, type BackupWithholdingOutcome } from '../backup-withholding';

type PartyRow = typeof schema.parties.$inferSelect;

export interface VendorWithholding extends BackupWithholdingOutcome {
  /** What the vendor's bills in the run settle for, before withholding. */
  gross: number;
}

/**
 * The vendors of a run that backup withholding applies to, with the amount.
 * Only vendors that withholding applies to are in the map.
 */
export async function computeRunWithholding(
  db: Database,
  args: {
    entityId: string;
    method: 'check' | 'ach';
    paymentDate: string | Date;
    items: Array<{ partyId: string; amount: number }>;
    parties: Array<Pick<PartyRow, 'id' | 'is1099Vendor'>>;
  },
): Promise<Map<string, VendorWithholding>> {
  const result = new Map<string, VendorWithholding>();
  for (const party of args.parties) {
    if (!party.is1099Vendor) continue;
    const gross = args.items.filter((i) => i.partyId === party.id).reduce((sum, i) => roundMoney(sum + i.amount), 0);
    if (!(gross > 0)) continue;
    const outcome = await computeBackupWithholding(db, {
      entityId: args.entityId,
      partyId: party.id,
      grossAmount: gross,
      date: args.paymentDate,
      paymentMethod: args.method,
    });
    if (outcome.amount > 0) result.set(party.id, { ...outcome, gross });
  }
  return result;
}

/** Whether the entity's chart has the account the withheld part is credited to (the same lookup the payment posting makes). */
export async function hasBackupWithholdingAccount(db: Database, entityId: string): Promise<boolean> {
  return Boolean(accountForRole(await loadEntityAccounts(db, entityId), 'backup_withholding_payable', ['2310']));
}
