/**
 * Holds on a payment run: reasons a vendor is left out of the payments until
 * someone looks at it.
 *
 * Nacha's 2026 fraud-monitoring rule asks originators to catch payments that
 * go to an account the vendor never had, so an ACH vendor whose bank details
 * changed in the last `holdWindowDays` (10 by default) is held until someone
 * with `banking:manage` verifies the change on the vendor. The other holds:
 *
 * - `no_bank_details`, `invalid_bank_details`: ACH needs a routing number, an
 *   account number and an account type, and the routing number must pass the
 *   ABA checksum. Fixed on the vendor, never released.
 * - `bank_details_changed`: see above. Cleared by verifying on the vendor.
 * - `prenote_required`, `prenote_pending`: with `requirePrenotes` on, a new
 *   account gets a $0 prenote in the next file and its payment waits three
 *   banking days. Releasable with a reason.
 * - `in_other_run`: one of the vendor's bills is in another draft or pending
 *   run. Releasable with a reason (the payment service still refuses to
 *   overpay a bill).
 * - `backup_withholding`: 24% backup withholding applies to the vendor and the
 *   chart of accounts has no Backup Withholding Payable account to put it in.
 *   Where the chart has one, withholding is no hold: the run takes it out of
 *   the payment (./approval.ts). Fixed on the chart, never released: paying
 *   the vendor in full would skip withholding the IRS requires.
 *
 * Holds live in `payment_runs.holds` as `{ partyId, reason }`. `reason` holds
 * a small JSON document (`code`, `message`, an optional `key` and, once
 * released, who, when and why) so the code survives a round trip; readers go
 * through `decodeHold`.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { abaChecksumValid, isAchBankingDay } from '@weldsuite/books-domain/us-compliance/nacha';
import { addDays } from '@weldsuite/books-domain/us-compliance/dates';
import type { AchSettings } from './settings';
import { computeRunWithholding, hasBackupWithholdingAccount } from './withholding';

type PartyRow = typeof schema.parties.$inferSelect;

export const HOLD_CODES = [
  'no_bank_details',
  'invalid_bank_details',
  'bank_details_changed',
  'prenote_required',
  'prenote_pending',
  'in_other_run',
  'backup_withholding',
] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/** Holds that only fixing the vendor clears: they can't be released from the run. */
export const BANK_HOLD_CODES: readonly HoldCode[] = ['no_bank_details', 'invalid_bank_details', 'bank_details_changed'];

/** Holds that are never released from the run (and so carry nothing over): the vendor or the chart has to be fixed. */
export const UNRELEASABLE_HOLD_CODES: readonly HoldCode[] = [...BANK_HOLD_CODES, 'backup_withholding'];

export interface Release {
  by: string;
  at: string;
  reason: string;
}

export interface RunHold {
  partyId: string;
  code: HoldCode;
  message: string;
  /** What the hold was about, to tell a new reason from the one a release covered (the bills of `in_other_run`). */
  key: string;
  released: Release | null;
}

export interface StoredHold {
  partyId: string;
  reason: string;
}

const isHoldCode = (value: unknown): value is HoldCode => (HOLD_CODES as readonly unknown[]).includes(value);

export function encodeHold(hold: RunHold): StoredHold {
  return {
    partyId: hold.partyId,
    reason: JSON.stringify({ code: hold.code, message: hold.message, key: hold.key, released: hold.released }),
  };
}

export function decodeHold(stored: StoredHold): RunHold {
  try {
    const parsed = JSON.parse(stored.reason) as Partial<RunHold> | null;
    if (parsed && isHoldCode(parsed.code)) {
      return {
        partyId: stored.partyId,
        code: parsed.code,
        message: typeof parsed.message === 'string' ? parsed.message : stored.reason,
        key: typeof parsed.key === 'string' ? parsed.key : '',
        released: parsed.released ?? null,
      };
    }
  } catch {
    // A plain-text reason from an older writer: show it as it is.
  }
  return { partyId: stored.partyId, code: 'in_other_run', message: stored.reason, key: '', released: null };
}

export const decodeHolds = (stored: StoredHold[] | null | undefined): RunHold[] => (stored ?? []).map(decodeHold);
export const encodeHolds = (holds: RunHold[]): StoredHold[] => holds.map(encodeHold);

/** Holds that still keep their vendor out of the run. */
export const activeHolds = (holds: RunHold[]): RunHold[] => holds.filter((h) => !h.released);

export function heldPartyIds(holds: RunHold[]): Set<string> {
  return new Set(activeHolds(holds).map((h) => h.partyId));
}

// ---------------------------------------------------------------------------
// Vendor ACH status (pure)

export interface VendorAchStatus {
  hasRouting: boolean;
  hasAccount: boolean;
  hasAccountType: boolean;
  routingValid: boolean;
  last4: string | null;
  accountType: string | null;
  bankDetailsChangedAt: string | null;
  bankDetailsVerifiedAt: string | null;
  /** The details were verified after they last changed (or never changed). */
  verified: boolean;
  /** Changed inside the hold window and not verified since: payments wait. */
  holdActive: boolean;
  /** Fully set up for a NACHA payment (ignoring holds). */
  ready: boolean;
}

type BankFields = Pick<
  PartyRow,
  | 'achRoutingNumber'
  | 'achAccountLast4'
  | 'achAccountType'
  | 'bankDetailsChangedAt'
  | 'bankDetailsVerifiedAt'
>;

export function vendorAchStatus(party: BankFields, holdWindowDays: number, now: Date): VendorAchStatus {
  const hasRouting = Boolean(party.achRoutingNumber);
  const hasAccount = Boolean(party.achAccountLast4);
  const hasAccountType = party.achAccountType === 'checking' || party.achAccountType === 'savings';
  const routingValid = hasRouting && abaChecksumValid(party.achRoutingNumber as string);
  const changed = party.bankDetailsChangedAt;
  const verifiedAt = party.bankDetailsVerifiedAt;
  const verified = !changed || Boolean(verifiedAt && verifiedAt.getTime() >= changed.getTime());
  const windowMs = holdWindowDays * 86_400_000;
  const holdActive = Boolean(changed) && !verified && now.getTime() - (changed as Date).getTime() < windowMs;
  return {
    hasRouting,
    hasAccount,
    hasAccountType,
    routingValid,
    last4: party.achAccountLast4 ?? null,
    accountType: party.achAccountType ?? null,
    bankDetailsChangedAt: changed ? changed.toISOString() : null,
    bankDetailsVerifiedAt: verifiedAt ? verifiedAt.toISOString() : null,
    verified,
    holdActive,
    ready: hasRouting && hasAccount && hasAccountType && routingValid,
  };
}

// ---------------------------------------------------------------------------
// Prenotes

export type PrenoteState = 'proven' | 'pending' | 'needed';

/** Banking days that must pass between a prenote and the first live entry (Nacha). */
export const PRENOTE_WAIT_BANKING_DAYS = 3;

/** The date `n` ACH banking days after `date`. */
export function addBankingDays(date: string, n: number): string {
  let current = date;
  let left = n;
  while (left > 0) {
    current = addDays(current, 1);
    if (isAchBankingDay(current)) left -= 1;
  }
  return current;
}

export interface AchHistory {
  /** When money last went (or a prior manual ACH payment says it went) to an account of this vendor: each entry is a date a live ACH payment was sent. */
  livePayments: Date[];
  /** Dates of files that carried a prenote for the vendor. */
  prenotes: Date[];
}

/**
 * Whether the vendor's current account has been proven: paid by ACH since the
 * details last changed, or prenoted at least three banking days ago.
 */
export function prenoteState(party: Pick<PartyRow, 'bankDetailsChangedAt'>, history: AchHistory, now: Date): PrenoteState {
  const since = party.bankDetailsChangedAt?.getTime() ?? 0;
  if (history.livePayments.some((d) => d.getTime() >= since)) return 'proven';
  const today = now.toISOString().slice(0, 10);
  const prenotes = history.prenotes.filter((d) => d.getTime() >= since);
  if (prenotes.length === 0) return 'needed';
  const aged = prenotes.some((d) => addBankingDays(d.toISOString().slice(0, 10), PRENOTE_WAIT_BANKING_DAYS) <= today);
  return aged ? 'proven' : 'pending';
}

/** ACH payment and prenote history per vendor, from payments and the files of exported runs. */
export async function loadAchHistory(
  db: Database,
  entityId: string,
  partyIds: string[],
): Promise<Map<string, AchHistory>> {
  const result = new Map<string, AchHistory>(partyIds.map((id) => [id, { livePayments: [], prenotes: [] }]));
  if (partyIds.length === 0) return result;

  const payments = await db
    .select({
      contactId: schema.payments.contactId,
      date: schema.payments.date,
      runStatus: schema.paymentRuns.status,
      fileGeneratedAt: schema.paymentRuns.fileGeneratedAt,
      paymentRunId: schema.payments.paymentRunId,
    })
    .from(schema.payments)
    .leftJoin(schema.paymentRuns, eq(schema.paymentRuns.id, schema.payments.paymentRunId))
    .where(
      and(
        eq(schema.payments.entityId, entityId),
        eq(schema.payments.type, 'sent'),
        eq(schema.payments.paymentMethod, 'ach'),
        isNull(schema.payments.deletedAt),
        inArray(schema.payments.contactId, partyIds),
        // A run's payment counts once its file went out; a manually recorded ACH payment counts at once.
        or(isNull(schema.payments.paymentRunId), inArray(schema.paymentRuns.status, ['exported', 'completed'])),
      ),
    );
  for (const row of payments) {
    result.get(row.contactId)?.livePayments.push(row.fileGeneratedAt ?? row.date);
  }

  const runs = await db
    .select({ holds: schema.paymentRuns.holds, fileGeneratedAt: schema.paymentRuns.fileGeneratedAt })
    .from(schema.paymentRuns)
    .where(
      and(
        eq(schema.paymentRuns.entityId, entityId),
        eq(schema.paymentRuns.method, 'ach'),
        isNull(schema.paymentRuns.deletedAt),
        inArray(schema.paymentRuns.status, ['exported', 'completed']),
      ),
    );
  for (const run of runs) {
    if (!run.fileGeneratedAt) continue;
    for (const hold of decodeHolds(run.holds)) {
      if (hold.code === 'prenote_required' && !hold.released) result.get(hold.partyId)?.prenotes.push(run.fileGeneratedAt);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Evaluating the holds of a run

export interface HoldItem {
  billId: string;
  amount: number;
  partyId: string;
}

export interface EvaluateHoldsArgs {
  entityId: string;
  /** The run being evaluated (excluded from the "other run" check); null for a run not stored yet. */
  runId: string | null;
  method: 'check' | 'ach';
  paymentDate: string;
  items: HoldItem[];
  ach: AchSettings;
  /** The run's earlier holds: a release carries over when the same hold comes back for the same reason. */
  previous?: RunHold[];
  now?: Date;
}

const money = (n: number): string => n.toFixed(2);

/**
 * The holds a run has right now: fresh from the vendors' current bank details
 * and the other open runs, with earlier releases carried over.
 */
export async function evaluateHolds(db: Database, args: EvaluateHoldsArgs): Promise<RunHold[]> {
  const now = args.now ?? new Date();
  const partyIds = [...new Set(args.items.map((i) => i.partyId))];
  if (partyIds.length === 0) return [];

  const parties = await db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds));
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const name = (partyId: string): string => partyById.get(partyId)?.displayName ?? partyId;

  const found: Array<Omit<RunHold, 'released'>> = [];

  if (args.method === 'ach') {
    const history = args.ach.requirePrenotes ? await loadAchHistory(db, args.entityId, partyIds) : null;
    for (const partyId of partyIds) {
      const party = partyById.get(partyId);
      if (!party) continue;
      const status = vendorAchStatus(party, args.ach.holdWindowDays, now);
      if (!status.hasRouting || !status.hasAccount || !status.hasAccountType) {
        const missing = [
          !status.hasRouting && 'routing number',
          !status.hasAccount && 'account number',
          !status.hasAccountType && 'account type',
        ].filter(Boolean);
        found.push({
          partyId,
          code: 'no_bank_details',
          key: '',
          message: `${name(partyId)} has no ACH ${missing.join(', ')}. Add the bank details on the vendor.`,
        });
        continue;
      }
      if (!status.routingValid) {
        found.push({
          partyId,
          code: 'invalid_bank_details',
          key: '',
          message: `${name(partyId)} has a routing number that fails the ABA checksum. Correct it on the vendor.`,
        });
        continue;
      }
      if (status.holdActive) {
        found.push({
          partyId,
          code: 'bank_details_changed',
          key: '',
          message: `${name(partyId)}'s bank details changed on ${status.bankDetailsChangedAt?.slice(0, 10)} and have not been verified. Call the vendor on a number you already had, then verify the change on the vendor.`,
        });
        continue;
      }
      if (history) {
        const state = prenoteState(party, history.get(partyId) ?? { livePayments: [], prenotes: [] }, now);
        if (state === 'needed') {
          found.push({
            partyId,
            code: 'prenote_required',
            key: '',
            message: `First payment to a new account for ${name(partyId)}: a $0 prenote goes in the next file and the payment waits ${PRENOTE_WAIT_BANKING_DAYS} banking days.`,
          });
        } else if (state === 'pending') {
          found.push({
            partyId,
            code: 'prenote_pending',
            key: '',
            message: `The prenote for ${name(partyId)} was sent less than ${PRENOTE_WAIT_BANKING_DAYS} banking days ago.`,
          });
        }
      }
    }
  }

  // Bills already in another open run.
  const otherRuns = await db
    .select({ id: schema.paymentRuns.id, items: schema.paymentRuns.items })
    .from(schema.paymentRuns)
    .where(
      and(
        eq(schema.paymentRuns.entityId, args.entityId),
        isNull(schema.paymentRuns.deletedAt),
        inArray(schema.paymentRuns.status, ['draft', 'pending_approval']),
      ),
    );
  const billRun = new Map<string, string>();
  for (const run of otherRuns) {
    if (run.id === args.runId) continue;
    for (const item of run.items ?? []) billRun.set(item.billId, run.id);
  }
  if (billRun.size > 0) {
    for (const partyId of partyIds) {
      const shared = args.items.filter((i) => i.partyId === partyId && billRun.has(i.billId));
      if (shared.length === 0) continue;
      const runIds = [...new Set(shared.map((i) => billRun.get(i.billId) as string))];
      found.push({
        partyId,
        code: 'in_other_run',
        key: shared.map((i) => i.billId).sort().join(','),
        message: `${shared.length} of ${name(partyId)}'s bills ${shared.length === 1 ? 'is' : 'are'} already in another open payment run (${runIds.join(', ')}).`,
      });
    }
  }

  // Backup withholding is taken out of the payment, so it only holds a vendor when the chart has nowhere to put it.
  const withholding = await computeRunWithholding(db, {
    entityId: args.entityId,
    method: args.method,
    paymentDate: args.paymentDate,
    items: args.items,
    parties,
  });
  if (withholding.size > 0 && !(await hasBackupWithholdingAccount(db, args.entityId))) {
    for (const [partyId, outcome] of withholding) {
      found.push({
        partyId,
        code: 'backup_withholding',
        key: '',
        message: `${name(partyId)} is subject to ${Math.round(outcome.rate * 100)}% backup withholding (${money(outcome.amount)} of ${money(outcome.gross)}), but this accounting entity has no Backup Withholding Payable account to put it in. Add one to the chart of accounts, then check the run again.`,
      });
    }
  }

  const previous = args.previous ?? [];
  return found.map((hold) => {
    const earlier = previous.find((p) => p.partyId === hold.partyId && p.code === hold.code && p.key === hold.key && p.released);
    // A hold that can't be released has nothing to carry: fixing the vendor (or the chart) is what clears it.
    const carry = earlier && !UNRELEASABLE_HOLD_CODES.includes(hold.code) ? earlier.released : null;
    return { ...hold, released: carry };
  });
}

/** Why a hold can't be released from the run, or null when it can. */
export function releaseBlocker(hold: RunHold): string | null {
  if (hold.code === 'no_bank_details' || hold.code === 'invalid_bank_details') {
    return 'Fix the vendor\'s bank details first: this hold can\'t be released from the run.';
  }
  if (hold.code === 'bank_details_changed') {
    return 'Verify the vendor\'s changed bank details on the vendor first; the hold then clears by itself.';
  }
  if (hold.code === 'backup_withholding') {
    return 'Add a Backup Withholding Payable account to the chart of accounts first: a vendor subject to backup withholding can\'t be paid in full.';
  }
  return null;
}

