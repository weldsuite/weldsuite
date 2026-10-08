/**
 * The NACHA file of an ACH payment run.
 *
 * Built from the run's payments (one credit per vendor), the vendors' bank
 * details and the bank account's ACH settings, with `buildNachaFile` from the
 * books domain doing the formatting. The vendor account numbers and (for a
 * balanced file) the company account number are decrypted here and each
 * decryption writes a `tax_id_reveals` row with the reason `nacha_file`.
 *
 * Two checks happen again at export, because the file is where money leaves:
 * a vendor whose bank details changed after the run was approved and haven't
 * been verified blocks the file, and every number is validated by the builder
 * (ABA checksums, amounts, Same Day limits) and the finished file is read back
 * with `verifyNachaFile`.
 */

import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  buildNachaFile,
  buildRmrSegments,
  suggestEffectiveEntryDate,
  verifyNachaFile,
  type NachaPayment,
  type NachaSecCode,
} from '@weldsuite/books-domain/us-compliance/nacha';
import { revealAccountNumber } from '../accounting-bank-accounts';
import { revealPartySecret, SecretNotFoundError } from '../vendor-tax-data';
import { PaymentRunError } from './errors';
import { decodeHolds } from './holds';
import { loadBankAccount, loadRun, type RunRow } from './runs';
import { achReadiness, effectiveOriginator, readAchSettings } from './settings';

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
type PartyRow = typeof schema.parties.$inferSelect;

const FALLBACK_TIME_ZONE = 'America/New_York';

/** The date and HHMM time in a time zone (Nacha dates are the originator's local ones). */
export function localDateTime(now: Date, timeZone: string | null | undefined): { date: string; time: string } {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone || FALLBACK_TIME_ZONE);
  } catch {
    parts = format(FALLBACK_TIME_ZONE);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}${get('minute')}` };
}

/** Letters A to Z, then digits: the modifier tells apart files made on the same day. */
export function fileIdModifierFor(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return alphabet[index] ?? alphabet[alphabet.length - 1]!;
}

function isIndividual(party: PartyRow): boolean {
  const classification = (party.w9 as { federalTaxClassification?: string } | null)?.federalTaxClassification;
  return party.kind === 'person' || classification === 'individual';
}

export interface NachaSummary {
  runId: string;
  fileName: string;
  fileDate: string;
  effectiveEntryDate: string;
  fileIdModifier: string;
  sameDay: boolean;
  balanced: boolean;
  paymentCount: number;
  prenoteCount: number;
  batchCount: number;
  recordCount: number;
  blockCount: number;
  entryHash: string;
  /** Dollars. */
  totalCredit: string;
  totalDebit: string;
  originator: {
    immediateDestination: string;
    immediateDestinationName: string;
    immediateOrigin: string;
    immediateOriginName: string;
    companyName: string;
    companyIdentification: string;
    odfiRoutingNumber: string;
  };
  payments: Array<{
    paymentId: string;
    partyId: string;
    name: string;
    amount: string;
    secCode: NachaSecCode;
    accountLast4: string | null;
    traceNumber: string | null;
  }>;
  prenotes: Array<{ partyId: string; name: string; traceNumber: string | null }>;
  warnings: Array<{ code: string; message: string; paymentId?: string }>;
}

export interface NachaFile {
  fileName: string;
  content: string;
  summary: NachaSummary;
  run: RunRow;
}

const cents = (n: number): string => (n / 100).toFixed(2);

export async function generateNachaFile(
  db: Database,
  env: KeyEnv,
  args: { entityId: string; runId: string; userId: string; now?: Date },
): Promise<NachaFile> {
  const now = args.now ?? new Date();
  const run = await loadRun(db, args.entityId, args.runId);
  if (run.method !== 'ach') throw new PaymentRunError('NOT_AN_ACH_RUN', 'This is a check run: it has no NACHA file.', 409);
  if (run.status !== 'approved' && run.status !== 'exported') {
    throw new PaymentRunError('RUN_NOT_APPROVED', 'The NACHA file can be made once the run is approved.', 409, { status: run.status });
  }

  const bank = await loadBankAccount(db, args.entityId, run.bankAccountId);
  const ach = readAchSettings(bank.achSettings);
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, args.entityId)).limit(1);
  if (!entity) throw new PaymentRunError('NOT_FOUND', 'Accounting entity not found', 404);
  if (run.sameDay && !ach.sameDayAllowed) {
    throw new PaymentRunError('SAME_DAY_NOT_ALLOWED', 'Same Day ACH is off for this bank account.', 409);
  }

  const offsetBank = ach.balanced
    ? ach.offsetBankAccountId && ach.offsetBankAccountId !== bank.id
      ? await loadBankAccount(db, args.entityId, ach.offsetBankAccountId)
      : bank
    : null;
  const effective = effectiveOriginator(bank, entity, ach);
  const readiness = achReadiness(effective, ach, Boolean(offsetBank?.routingNumber && offsetBank.accountNumberEncrypted));
  if (!readiness.ready) {
    throw new PaymentRunError(
      'ACH_SETTINGS_INCOMPLETE',
      `The bank account's ACH settings are incomplete: ${readiness.missing.join(', ')}.`,
      409,
      { missing: readiness.missing },
    );
  }

  const payments = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.paymentRunId, run.id), eq(schema.payments.type, 'sent'), isNull(schema.payments.deletedAt)))
    .orderBy(schema.payments.createdAt, schema.payments.id);
  const prenoteHolds = decodeHolds(run.holds).filter((h) => h.code === 'prenote_required' && !h.released);
  if (payments.length === 0 && prenoteHolds.length === 0) {
    throw new PaymentRunError('NOTHING_TO_EXPORT', 'This run has no active payments to put in a file.', 409);
  }

  const partyIds = [...new Set([...payments.map((p) => p.contactId), ...prenoteHolds.map((h) => h.partyId)])];
  const parties = partyIds.length ? await db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds)) : [];
  const partyById = new Map(parties.map((p) => [p.id, p]));

  // A vendor whose details changed after approval would be paid to an account nobody signed off.
  const approvedAt = (run.approvals ?? []).reduce((latest, a) => (a.at > latest ? a.at : latest), '');
  const changed = parties.filter((p) => {
    if (!p.bankDetailsChangedAt) return false;
    const verified = p.bankDetailsVerifiedAt && p.bankDetailsVerifiedAt.getTime() >= p.bankDetailsChangedAt.getTime();
    return !verified && p.bankDetailsChangedAt.toISOString() > approvedAt;
  });
  if (changed.length > 0) {
    throw new PaymentRunError(
      'BANK_DETAILS_CHANGED',
      `Bank details changed after this run was approved and haven't been verified: ${changed.map((p) => p.displayName ?? p.id).join(', ')}. Verify the change on the vendor, or void the payment.`,
      409,
      { vendors: changed.map((p) => ({ partyId: p.id, name: p.displayName, changedAt: p.bankDetailsChangedAt })) },
    );
  }

  const allocations = payments.length
    ? await db
        .select({
          paymentId: schema.paymentAllocations.paymentId,
          amount: schema.paymentAllocations.amount,
          billNumber: schema.bills.billNumber,
        })
        .from(schema.paymentAllocations)
        .innerJoin(schema.bills, eq(schema.bills.id, schema.paymentAllocations.billId))
        .where(and(inArray(schema.paymentAllocations.paymentId, payments.map((p) => p.id)), isNull(schema.paymentAllocations.deletedAt)))
    : [];

  const reveal = async (party: PartyRow): Promise<string> => {
    try {
      return await revealPartySecret(db, env, {
        party,
        field: 'ach_account_number',
        userId: args.userId,
        reason: 'nacha_file',
        entityId: args.entityId,
      });
    } catch (err) {
      if (err instanceof SecretNotFoundError) {
        throw new PaymentRunError('NO_ACCOUNT_NUMBER', `${party.displayName ?? party.id} has no ACH account number on file.`, 409, { partyId: party.id });
      }
      throw err;
    }
  };

  const secFor = (party: PartyRow): NachaSecCode => (run.secCode as NachaSecCode | null) ?? (isIndividual(party) ? 'PPD' : ach.defaultSecCode);
  const nachaPayments: NachaPayment[] = [];
  const meta = new Map<string, { partyId: string; name: string; secCode: NachaSecCode; last4: string | null; amount: string }>();

  for (const payment of payments) {
    const party = partyById.get(payment.contactId);
    if (!party) throw new PaymentRunError('NOT_FOUND', `Vendor ${payment.contactId} not found`, 404);
    if (!party.achRoutingNumber) throw new PaymentRunError('NO_BANK_DETAILS', `${party.displayName ?? party.id} has no ACH routing number.`, 409, { partyId: party.id });
    const secCode = secFor(party);
    const own = allocations.filter((a) => a.paymentId === payment.id);
    const remittance = buildRmrSegments(
      own.map((a) => ({ reference: a.billNumber ?? payment.id, amount: Number.parseFloat(a.amount) })),
    );
    const name = party.displayName ?? party.id;
    nachaPayments.push({
      id: payment.id,
      secCode,
      name,
      routingNumber: party.achRoutingNumber,
      accountNumber: await reveal(party),
      accountType: party.achAccountType === 'savings' ? 'savings' : 'checking',
      amount: Number.parseFloat(payment.amount),
      identification: own.length === 1 ? (own[0]?.billNumber ?? '') : (party.partyCode ?? ''),
      ...(secCode === 'CCD+' || secCode === 'CTX' ? { paymentInfo: remittance } : {}),
    });
    meta.set(payment.id, { partyId: party.id, name, secCode, last4: party.achAccountLast4, amount: Number.parseFloat(payment.amount).toFixed(2) });
  }

  for (const hold of prenoteHolds) {
    const party = partyById.get(hold.partyId);
    if (!party?.achRoutingNumber) continue;
    const name = party.displayName ?? party.id;
    const sec = secFor(party);
    nachaPayments.push({
      id: `prenote:${party.id}`,
      secCode: sec === 'CCD+' || sec === 'CTX' ? 'CCD' : sec,
      name,
      routingNumber: party.achRoutingNumber,
      accountNumber: await reveal(party),
      accountType: party.achAccountType === 'savings' ? 'savings' : 'checking',
      amount: 0,
      prenote: true,
    });
    meta.set(`prenote:${party.id}`, { partyId: party.id, name, secCode: sec, last4: party.achAccountLast4, amount: '0.00' });
  }

  let offsetAccount: { routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings'; name?: string } | undefined;
  if (offsetBank) {
    const revealed = await revealAccountNumber(db, env, { account: offsetBank, userId: args.userId, reason: 'nacha_file' });
    offsetAccount = {
      routingNumber: offsetBank.routingNumber as string,
      accountNumber: revealed.accountNumber,
      accountType: offsetBank.accountType === 'savings' ? 'savings' : 'checking',
      name: effective.companyName,
    };
  }

  const local = localDateTime(now, entity.timezone);
  const effectiveEntryDate = suggestEffectiveEntryDate(run.paymentDate, local.date, run.sameDay);
  const sameDayRuns = await db
    .select({ id: schema.paymentRuns.id, fileGeneratedAt: schema.paymentRuns.fileGeneratedAt })
    .from(schema.paymentRuns)
    .where(
      and(
        eq(schema.paymentRuns.bankAccountId, bank.id),
        eq(schema.paymentRuns.method, 'ach'),
        ne(schema.paymentRuns.id, run.id),
        isNull(schema.paymentRuns.deletedAt),
        isNotNull(schema.paymentRuns.fileGeneratedAt),
      ),
    );
  const sameDayCount = sameDayRuns.filter((r) => r.fileGeneratedAt && localDateTime(r.fileGeneratedAt, entity.timezone).date === local.date).length;
  const fileIdModifier = fileIdModifierFor(sameDayCount);

  const built = buildNachaFile({
    originator: {
      immediateDestination: effective.immediateDestination as string,
      immediateDestinationName: effective.immediateDestinationName,
      immediateOrigin: effective.immediateOrigin as string,
      immediateOriginName: effective.immediateOriginName,
      companyName: effective.companyName,
      companyIdentification: effective.companyIdentification as string,
      ...(effective.odfiRoutingNumber ? { odfiRoutingNumber: effective.odfiRoutingNumber } : {}),
      ...(offsetAccount ? { offsetAccount } : {}),
    },
    payments: nachaPayments,
    effectiveEntryDate,
    fileCreation: { date: local.date, time: local.time },
    fileIdModifier,
    defaultSecCode: run.secCode ? (run.secCode as NachaSecCode) : ach.defaultSecCode,
    entryDescription: ach.entryDescription ?? 'VENDOR PAY',
    balanced: ach.balanced,
    sameDay: run.sameDay,
  });
  if (!built.ok) {
    throw new PaymentRunError('NACHA_INVALID', 'The NACHA file can\'t be made: fix the issues listed and try again.', 422, {
      errors: built.errors,
      warnings: built.warnings,
    });
  }
  const verification = verifyNachaFile(built.content);
  if (!verification.ok) {
    throw new PaymentRunError('NACHA_INVALID', 'The NACHA file failed its own check and was not released.', 422, {
      errors: verification.issues,
      warnings: built.warnings,
    });
  }

  const fileName = `ach-${run.paymentDate}-${run.id}.ach`;
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: 'exported', fileName, fileGeneratedAt: now, updatedAt: now })
    .where(eq(schema.paymentRuns.id, run.id))
    .returning();

  const traceOf = new Map(built.traces.filter((t) => t.paymentId).map((t) => [t.paymentId as string, t.traceNumber]));
  const entries = [...meta.entries()];
  const summary: NachaSummary = {
    runId: run.id,
    fileName,
    fileDate: local.date,
    effectiveEntryDate,
    fileIdModifier,
    sameDay: run.sameDay,
    balanced: ach.balanced,
    paymentCount: payments.length,
    prenoteCount: prenoteHolds.length,
    batchCount: built.batchCount,
    recordCount: built.recordCount,
    blockCount: built.blockCount,
    entryHash: built.entryHash,
    totalCredit: cents(built.totalCreditCents),
    totalDebit: cents(built.totalDebitCents),
    originator: {
      immediateDestination: effective.immediateDestination as string,
      immediateDestinationName: effective.immediateDestinationName,
      immediateOrigin: effective.immediateOrigin as string,
      immediateOriginName: effective.immediateOriginName,
      companyName: effective.companyName,
      companyIdentification: effective.companyIdentification as string,
      odfiRoutingNumber: effective.odfiRoutingNumber ?? (effective.immediateDestination as string),
    },
    payments: entries
      .filter(([id]) => !id.startsWith('prenote:'))
      .map(([id, m]) => ({
        paymentId: id,
        partyId: m.partyId,
        name: m.name,
        amount: m.amount,
        secCode: m.secCode,
        accountLast4: m.last4,
        traceNumber: traceOf.get(id) ?? null,
      })),
    prenotes: entries
      .filter(([id]) => id.startsWith('prenote:'))
      .map(([id, m]) => ({ partyId: m.partyId, name: m.name, traceNumber: traceOf.get(id) ?? null })),
    warnings: built.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.paymentId ? { paymentId: w.paymentId } : {}),
    })),
  };
  return { fileName, content: built.content, summary, run: updated ?? run };
}

/** The bank accepted the file: the run is finished. */
export async function completeAchRun(db: Database, entityId: string, runId: string): Promise<RunRow> {
  const run = await loadRun(db, entityId, runId);
  if (run.method !== 'ach') throw new PaymentRunError('NOT_AN_ACH_RUN', 'Only an ACH run is completed this way: print and mark its checks instead.', 409);
  if (run.status !== 'exported') {
    throw new PaymentRunError('INVALID_STATE', 'Make and send the NACHA file first: a run is completed once the bank has accepted it.', 409, { status: run.status });
  }
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(and(eq(schema.paymentRuns.id, run.id), eq(schema.paymentRuns.status, 'exported')))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were completing it. Reload it and try again.', 409);
  return updated;
}
