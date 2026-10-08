/**
 * Payment runs: the plan of a batch of vendor payments, before and while it is
 * approved. A run is a list of bills with the amount to pay on each; the
 * payments themselves are created when the last required approval comes in
 * (./approval.ts).
 *
 *   draft -> pending_approval -> approved -> exported -> completed
 *      \_________________________\-> cancelled (draft / pending only)
 *
 * A rejected run goes back to draft. Holds (./holds.ts) keep single vendors
 * out of the payments without stopping the run.
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { formatPostalAddressLines } from '@weldsuite/books-domain/accounting-address';
import {
  BACKUP_WITHHOLDING_RATE,
  type BackupWithholdingReason,
} from '@weldsuite/books-domain/us-compliance/backup-withholding';
import { computeBackupWithholding } from '../backup-withholding';
import { resolveEntityBaseCurrency } from '../../lib/entity-context';
import { paymentNetAmount } from '../accounting-payments';
import { roundMoney } from '../accounting-posting';
import { badRequest, notFound, PaymentRunError } from './errors';
import {
  activeHolds,
  decodeHolds,
  encodeHolds,
  evaluateHolds,
  heldPartyIds,
  loadAchHistory,
  prenoteState,
  releaseBlocker,
  vendorAchStatus,
  type RunHold,
} from './holds';
import { ACH_SEC_CODES, DEFAULT_HOLD_WINDOW_DAYS, readAchSettings } from './settings';
import { computeRunWithholding, type VendorWithholding } from './withholding';

export type RunRow = typeof schema.paymentRuns.$inferSelect;
export type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
export type RunMethod = 'check' | 'ach';
export type RunStatus = 'draft' | 'pending_approval' | 'approved' | 'exported' | 'completed' | 'cancelled';
export interface RunItem {
  billId: string;
  amount: number;
  partyId: string;
}

/** Bill statuses a run may pay (matches what reconciliation treats as open). */
export const PAYABLE_BILL_STATUSES = ['approved', 'partial', 'overdue'] as const;

export const OPEN_RUN_STATUSES = ['draft', 'pending_approval'] as const;

// ---------------------------------------------------------------------------
// Loading

export async function loadBankAccount(db: Database, entityId: string, bankAccountId: string): Promise<BankAccountRow> {
  const [bank] = await db
    .select()
    .from(schema.bankAccounts)
    .where(
      and(
        eq(schema.bankAccounts.id, bankAccountId),
        eq(schema.bankAccounts.entityId, entityId),
        isNull(schema.bankAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!bank) throw notFound('Bank account', bankAccountId);
  return bank;
}

export async function loadRun(db: Database, entityId: string, runId: string): Promise<RunRow> {
  const [run] = await db
    .select()
    .from(schema.paymentRuns)
    .where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.entityId, entityId), isNull(schema.paymentRuns.deletedAt)))
    .limit(1);
  if (!run) throw notFound('Payment run', runId);
  return run;
}

export function assertStatus(run: RunRow, allowed: RunStatus[], action: string): void {
  if (!(allowed as string[]).includes(run.status)) {
    throw new PaymentRunError(
      'INVALID_STATE',
      `A ${run.status.replaceAll('_', ' ')} run can't be ${action}.`,
      409,
      { status: run.status },
    );
  }
}

// ---------------------------------------------------------------------------
// Items

export interface RunInputItem {
  billId: string;
  amount: number;
}

/** Validate the bills and amounts of a run and attach each bill's vendor. */
export async function resolveItems(db: Database, entityId: string, input: RunInputItem[]): Promise<RunItem[]> {
  if (input.length === 0) throw badRequest('NO_ITEMS', 'A payment run needs at least one bill.');
  const ids = input.map((i) => i.billId);
  if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_BILL', 'A bill can only be in a run once.');

  const bills = await db
    .select()
    .from(schema.bills)
    .where(and(inArray(schema.bills.id, ids), isNull(schema.bills.deletedAt)));
  const byId = new Map(bills.map((b) => [b.id, b]));
  const baseCurrency = await resolveEntityBaseCurrency(db, entityId);

  const items: RunItem[] = [];
  for (const item of input) {
    const bill = byId.get(item.billId);
    if (!bill) throw badRequest('BILL_NOT_FOUND', `Bill ${item.billId} not found.`, { billId: item.billId });
    const label = bill.billNumber ?? bill.id;
    if (bill.entityId !== entityId) {
      throw badRequest('BILL_OTHER_ENTITY', `Bill ${label} belongs to a different accounting entity.`, { billId: bill.id });
    }
    if (!(PAYABLE_BILL_STATUSES as readonly string[]).includes(bill.status) || bill.type !== 'standard') {
      throw badRequest('BILL_NOT_PAYABLE', `Bill ${label} is ${bill.status} and can't be paid in a run.`, { billId: bill.id });
    }
    if ((bill.currency ?? baseCurrency) !== baseCurrency) {
      throw badRequest('BILL_CURRENCY', `Bill ${label} is in ${bill.currency}: payment runs pay ${baseCurrency} bills only.`, { billId: bill.id });
    }
    const amount = roundMoney(item.amount);
    if (!(amount > 0)) throw badRequest('INVALID_AMOUNT', `The amount for bill ${label} must be greater than zero.`, { billId: bill.id });
    const open = Number.parseFloat(bill.balanceDue ?? '0');
    if (amount > open + 0.005) {
      throw badRequest(
        'AMOUNT_EXCEEDS_BALANCE',
        `The amount for bill ${label} (${amount.toFixed(2)}) is more than its open balance (${open.toFixed(2)}).`,
        { billId: bill.id, balanceDue: open.toFixed(2) },
      );
    }
    items.push({ billId: bill.id, amount, partyId: bill.contactId });
  }
  return items;
}

/** Total and payment count of what the run will pay: held vendors are left out. */
export function totalsOf(items: RunItem[], holds: RunHold[]): { totalAmount: string; heldAmount: string; paymentCount: number } {
  const held = heldPartyIds(holds);
  const payable = items.filter((i) => !held.has(i.partyId));
  const total = payable.reduce((sum, i) => roundMoney(sum + i.amount), 0);
  const heldTotal = items.filter((i) => held.has(i.partyId)).reduce((sum, i) => roundMoney(sum + i.amount), 0);
  return {
    totalAmount: total.toFixed(2),
    heldAmount: heldTotal.toFixed(2),
    paymentCount: new Set(payable.map((i) => i.partyId)).size,
  };
}

// ---------------------------------------------------------------------------
// Create and edit

export interface CreateRunInput {
  entityId: string;
  userId: string | null;
  bankAccountId: string;
  method: RunMethod;
  /** YYYY-MM-DD */
  paymentDate: string;
  secCode?: string | null;
  sameDay?: boolean;
  items: RunInputItem[];
  requiredApprovals?: 1 | 2;
  notes?: string | null;
  /** The caller has `banking:manage`, which lowering an ACH run below two approvals needs. */
  canLowerApprovals: boolean;
}

function validateAchOptions(
  method: RunMethod,
  input: { secCode?: string | null; sameDay?: boolean },
  bank: BankAccountRow,
): void {
  if (method === 'check') {
    if (input.secCode || input.sameDay) throw badRequest('ACH_ONLY', 'An SEC code and Same Day ACH apply to ACH runs only.');
    return;
  }
  if (input.secCode && !(ACH_SEC_CODES as readonly string[]).includes(input.secCode)) {
    throw badRequest('INVALID_SEC_CODE', `SEC code ${input.secCode} isn't supported: use PPD, CCD, CCD+ or CTX.`);
  }
  if (input.sameDay && !readAchSettings(bank.achSettings).sameDayAllowed) {
    throw badRequest('SAME_DAY_NOT_ALLOWED', 'Same Day ACH is off for this bank account. Turn it on in the ACH settings first.');
  }
}

export async function createRun(db: Database, input: CreateRunInput): Promise<{ run: RunRow; holds: RunHold[]; approvalsLowered: boolean }> {
  const bank = await loadBankAccount(db, input.entityId, input.bankAccountId);
  if (bank.isActive === false) throw badRequest('BANK_ACCOUNT_INACTIVE', 'This bank account is inactive.');
  validateAchOptions(input.method, input, bank);
  if (input.method === 'check' && (bank.nextCheckNumber === null || bank.nextCheckNumber === undefined)) {
    throw badRequest('CHECK_NUMBER_REQUIRED', 'Set the next check number in the bank account\'s check settings before paying by check.');
  }

  const defaultApprovals = input.method === 'ach' ? 2 : 1;
  const requiredApprovals = input.requiredApprovals ?? defaultApprovals;
  const approvalsLowered = input.method === 'ach' && requiredApprovals < 2;
  if (approvalsLowered && !input.canLowerApprovals) {
    throw new PaymentRunError('APPROVALS_REQUIRE_MANAGE', 'Paying by ACH with fewer than two approvals needs the banking:manage permission.', 403);
  }

  const items = await resolveItems(db, input.entityId, input.items);
  const ach = readAchSettings(bank.achSettings);
  const holds = await evaluateHolds(db, {
    entityId: input.entityId,
    runId: null,
    method: input.method,
    paymentDate: input.paymentDate,
    items,
    ach,
  });
  const totals = totalsOf(items, holds);

  const now = new Date();
  const [run] = await db
    .insert(schema.paymentRuns)
    .values({
      id: generateId('prn'),
      entityId: input.entityId,
      bankAccountId: bank.id,
      method: input.method,
      status: 'draft',
      paymentDate: input.paymentDate,
      secCode: input.method === 'ach' ? input.secCode ?? null : null,
      sameDay: input.method === 'ach' && Boolean(input.sameDay),
      totalAmount: totals.totalAmount,
      paymentCount: totals.paymentCount,
      requiredApprovals,
      approvals: [],
      items,
      holds: encodeHolds(holds),
      createdBy: input.userId,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { run, holds, approvalsLowered };
}

export interface UpdateRunInput {
  entityId: string;
  runId: string;
  paymentDate?: string;
  secCode?: string | null;
  sameDay?: boolean;
  items?: RunInputItem[];
  requiredApprovals?: 1 | 2;
  notes?: string | null;
  bankAccountId?: string;
  canLowerApprovals: boolean;
}

export async function updateRun(db: Database, input: UpdateRunInput): Promise<{ run: RunRow; before: RunRow; holds: RunHold[] }> {
  const before = await loadRun(db, input.entityId, input.runId);
  assertStatus(before, ['draft'], 'edited (reject or cancel it, or start a new one)');

  const bankAccountId = input.bankAccountId ?? before.bankAccountId;
  const bank = await loadBankAccount(db, input.entityId, bankAccountId);
  const method = before.method as RunMethod;
  const secCode = input.secCode !== undefined ? input.secCode : before.secCode;
  const sameDay = input.sameDay ?? before.sameDay;
  validateAchOptions(method, { secCode, sameDay }, bank);
  if (method === 'check' && (bank.nextCheckNumber === null || bank.nextCheckNumber === undefined)) {
    throw badRequest('CHECK_NUMBER_REQUIRED', 'Set the next check number in the bank account\'s check settings before paying by check.');
  }

  const requiredApprovals = input.requiredApprovals ?? before.requiredApprovals;
  if (method === 'ach' && requiredApprovals < 2 && requiredApprovals !== before.requiredApprovals && !input.canLowerApprovals) {
    throw new PaymentRunError('APPROVALS_REQUIRE_MANAGE', 'Paying by ACH with fewer than two approvals needs the banking:manage permission.', 403);
  }

  const items = input.items ? await resolveItems(db, input.entityId, input.items) : (before.items ?? []);
  const paymentDate = input.paymentDate ?? before.paymentDate;
  const holds = await evaluateHolds(db, {
    entityId: input.entityId,
    runId: before.id,
    method,
    paymentDate,
    items,
    ach: readAchSettings(bank.achSettings),
    previous: decodeHolds(before.holds),
  });
  const totals = totalsOf(items, holds);

  const [run] = await db
    .update(schema.paymentRuns)
    .set({
      bankAccountId,
      paymentDate,
      secCode: method === 'ach' ? secCode ?? null : null,
      sameDay: method === 'ach' && Boolean(sameDay),
      requiredApprovals,
      notes: input.notes !== undefined ? input.notes : before.notes,
      items,
      holds: encodeHolds(holds),
      totalAmount: totals.totalAmount,
      paymentCount: totals.paymentCount,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.paymentRuns.id, before.id), eq(schema.paymentRuns.status, 'draft')))
    .returning();
  if (!run) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were editing it. Reload it and try again.', 409);
  return { run, before, holds };
}

/** Re-evaluate a run's holds against the vendors' current details and store them with the new totals. */
export async function refreshHolds(db: Database, run: RunRow, bank?: BankAccountRow): Promise<{ run: RunRow; holds: RunHold[] }> {
  const account = bank ?? (await loadBankAccount(db, run.entityId, run.bankAccountId));
  const items = run.items ?? [];
  const holds = await evaluateHolds(db, {
    entityId: run.entityId,
    runId: run.id,
    method: run.method as RunMethod,
    paymentDate: run.paymentDate,
    items,
    ach: readAchSettings(account.achSettings),
    previous: decodeHolds(run.holds),
  });
  const totals = totalsOf(items, holds);
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ holds: encodeHolds(holds), totalAmount: totals.totalAmount, paymentCount: totals.paymentCount, updatedAt: new Date() })
    .where(eq(schema.paymentRuns.id, run.id))
    .returning();
  return { run: updated ?? run, holds };
}

export async function submitRun(db: Database, entityId: string, runId: string): Promise<{ run: RunRow; holds: RunHold[] }> {
  const run = await loadRun(db, entityId, runId);
  assertStatus(run, ['draft'], 'submitted');
  if ((run.items ?? []).length === 0) throw badRequest('NO_ITEMS', 'A payment run needs at least one bill.');
  // Bills may have been paid or edited since the draft was made.
  await resolveItems(db, entityId, (run.items ?? []).map((i) => ({ billId: i.billId, amount: i.amount })));
  const refreshed = await refreshHolds(db, run);
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: 'pending_approval', approvals: [], updatedAt: new Date() })
    .where(and(eq(schema.paymentRuns.id, run.id), eq(schema.paymentRuns.status, 'draft')))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were submitting it. Reload it and try again.', 409);
  return { run: updated, holds: refreshed.holds };
}

export async function rejectRun(db: Database, entityId: string, runId: string): Promise<RunRow> {
  const run = await loadRun(db, entityId, runId);
  assertStatus(run, ['pending_approval'], 'rejected');
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: 'draft', approvals: [], updatedAt: new Date() })
    .where(and(eq(schema.paymentRuns.id, run.id), eq(schema.paymentRuns.status, 'pending_approval')))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were rejecting it. Reload it and try again.', 409);
  return updated;
}

export async function cancelRun(db: Database, entityId: string, runId: string): Promise<RunRow> {
  const run = await loadRun(db, entityId, runId);
  assertStatus(run, ['draft', 'pending_approval'], 'cancelled (void its payments instead)');
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(schema.paymentRuns.id, run.id), inArray(schema.paymentRuns.status, ['draft', 'pending_approval'])))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were cancelling it. Reload it and try again.', 409);
  return updated;
}

export async function deleteRun(db: Database, entityId: string, runId: string): Promise<RunRow> {
  const run = await loadRun(db, entityId, runId);
  assertStatus(run, ['draft'], 'deleted (cancel it instead)');
  const now = new Date();
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(schema.paymentRuns.id, run.id), eq(schema.paymentRuns.status, 'draft')))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were deleting it. Reload it and try again.', 409);
  return updated;
}

// ---------------------------------------------------------------------------
// Releasing holds

export interface ReleaseHoldResult {
  run: RunRow;
  released: RunHold[];
  /** Holds on the vendor that are gone because the vendor was fixed (details verified), not released. */
  cleared: number;
}

/**
 * Release a vendor's holds. Bank-detail holds are never released from the
 * run: they clear once the vendor's details are verified (or fixed), which
 * this re-checks first. The other holds need a reason, recorded with who and
 * when.
 */
export async function releaseHold(
  db: Database,
  args: { entityId: string; runId: string; partyId: string; userId: string; reason?: string | null },
): Promise<ReleaseHoldResult> {
  const run = await loadRun(db, args.entityId, args.runId);
  assertStatus(run, ['draft', 'pending_approval'], 'changed: its payments are already made');
  const before = decodeHolds(run.holds);
  const refreshed = await refreshHolds(db, run);
  const partyHolds = activeHolds(refreshed.holds).filter((h) => h.partyId === args.partyId);
  const hadHolds = before.some((h) => h.partyId === args.partyId && !h.released);
  if (partyHolds.length === 0) {
    if (!hadHolds) throw new PaymentRunError('NOT_HELD', 'This vendor has no hold on the run.', 409);
    return { run: refreshed.run, released: [], cleared: before.filter((h) => h.partyId === args.partyId && !h.released).length };
  }

  const blocked = partyHolds.find((h) => releaseBlocker(h));
  if (blocked) throw new PaymentRunError('HOLD_NOT_RELEASABLE', releaseBlocker(blocked) as string, 409, { code: blocked.code });
  const reason = args.reason?.trim();
  if (!reason || reason.length < 3) {
    throw badRequest('REASON_REQUIRED', 'Say why the hold is released (at least a few words); it is kept with the run.');
  }

  const release = { by: args.userId, at: new Date().toISOString(), reason: reason.slice(0, 500) };
  const next = refreshed.holds.map((h) => (h.partyId === args.partyId && !h.released ? { ...h, released: release } : h));
  const totals = totalsOf(refreshed.run.items ?? [], next);
  const [updated] = await db
    .update(schema.paymentRuns)
    .set({ holds: encodeHolds(next), totalAmount: totals.totalAmount, paymentCount: totals.paymentCount, updatedAt: new Date() })
    .where(and(eq(schema.paymentRuns.id, run.id), inArray(schema.paymentRuns.status, ['draft', 'pending_approval'])))
    .returning();
  if (!updated) throw new PaymentRunError('INVALID_STATE', 'The run changed while you were releasing the hold. Reload it and try again.', 409);
  return { run: updated, released: next.filter((h) => h.partyId === args.partyId), cleared: 0 };
}

// ---------------------------------------------------------------------------
// Listing and detail

function encodeCursor(row: Pick<RunRow, 'createdAt' | 'id'>): string {
  return btoa(`${row.createdAt.toISOString()}|${row.id}`);
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = atob(cursor).split('|');
    const createdAt = new Date(iso ?? '');
    return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export interface ListRunsFilter {
  status?: string;
  method?: string;
  bankAccountId?: string;
  limit: number;
  cursor?: string;
}

export interface RunSummary {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  method: string;
  status: string;
  paymentDate: string;
  secCode: string | null;
  sameDay: boolean;
  totalAmount: string;
  paymentCount: number;
  requiredApprovals: number;
  approvalCount: number;
  billCount: number;
  heldVendorCount: number;
  fileName: string | null;
  fileGeneratedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  notes: string | null;
}

export function summarize(run: RunRow, bankAccountName: string | null = null): RunSummary {
  const holds = activeHolds(decodeHolds(run.holds));
  return {
    id: run.id,
    bankAccountId: run.bankAccountId,
    bankAccountName,
    method: run.method,
    status: run.status,
    paymentDate: run.paymentDate,
    secCode: run.secCode,
    sameDay: run.sameDay,
    totalAmount: run.totalAmount,
    paymentCount: run.paymentCount,
    requiredApprovals: run.requiredApprovals,
    approvalCount: (run.approvals ?? []).length,
    billCount: (run.items ?? []).length,
    heldVendorCount: new Set(holds.map((h) => h.partyId)).size,
    fileName: run.fileName,
    fileGeneratedAt: run.fileGeneratedAt,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    notes: run.notes,
  };
}

export async function listRuns(
  db: Database,
  entityId: string,
  filter: ListRunsFilter,
): Promise<{ rows: RunSummary[]; totalCount: number; hasMore: boolean; cursor: string | null }> {
  const t = schema.paymentRuns;
  const base = [eq(t.entityId, entityId), isNull(t.deletedAt)];
  if (filter.status) base.push(eq(t.status, filter.status));
  if (filter.method) base.push(eq(t.method, filter.method));
  if (filter.bankAccountId) base.push(eq(t.bankAccountId, filter.bankAccountId));

  const after = filter.cursor ? decodeCursor(filter.cursor) : null;
  if (filter.cursor && !after) throw badRequest('INVALID_CURSOR', 'Invalid cursor');
  const page = after ? [...base, or(lt(t.createdAt, after.createdAt), and(eq(t.createdAt, after.createdAt), lt(t.id, after.id)))!] : base;

  const [rows, count] = await Promise.all([
    db
      .select({ run: t, bankAccountName: schema.bankAccounts.name })
      .from(t)
      .leftJoin(schema.bankAccounts, eq(schema.bankAccounts.id, t.bankAccountId))
      .where(and(...page))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(filter.limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...base)),
  ]);
  const hasMore = rows.length > filter.limit;
  const pageRows = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    rows: pageRows.map((r) => summarize(r.run, r.bankAccountName)),
    totalCount: Number(count[0]?.count ?? 0),
    hasMore,
    cursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]!.run) : null,
  };
}

export interface RunVendorView {
  partyId: string;
  name: string;
  /** What the vendor's bills in the run settle for, before backup withholding. */
  amount: string;
  billCount: number;
  held: boolean;
  /**
   * Backup withholding on the vendor's payment: what was kept back once the
   * payment is made, a preview (worked out again when the payment is made)
   * before that. Null when none applies. `net` is what the vendor is paid.
   */
  backupWithholding: { amount: string; net: string; reason: BackupWithholdingReason | null; rate: number } | null;
  holds: Array<{ code: string; message: string; releasable: boolean; released: RunHold['released']; blocker: string | null }>;
  payment: {
    id: string;
    /** What the payment settles, before withholding. */
    amount: string;
    backupWithholdingAmount: string | null;
    /** What the bank was credited, the check is written for and the NACHA file pays. */
    netAmount: string;
    checkNumber: string | null;
    checkStatus: string | null;
    deleted: boolean;
  } | null;
}

/**
 * A run with its bills, vendors (and what holds them), payments, approvals and history.
 *
 * `totalAmount` is what the run's bills settle for; `withheldAmount` is the
 * backup withholding kept back from it and `netAmount` what leaves the bank
 * (the payments that exist, or the vendors that are not held while the run is
 * still being planned).
 */
export async function getRunDetail(db: Database, entityId: string, runId: string) {
  const run = await loadRun(db, entityId, runId);
  const items = run.items ?? [];
  const holds = decodeHolds(run.holds);
  const billIds = items.map((i) => i.billId);
  const partyIds = [...new Set(items.map((i) => i.partyId))];

  const [bills, parties, payments, bank, history] = await Promise.all([
    billIds.length ? db.select().from(schema.bills).where(inArray(schema.bills.id, billIds)) : Promise.resolve([]),
    partyIds.length ? db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds)) : Promise.resolve([]),
    db.select().from(schema.payments).where(eq(schema.payments.paymentRunId, run.id)),
    db
      .select({ id: schema.bankAccounts.id, name: schema.bankAccounts.name, last4: schema.bankAccounts.accountNumberLast4 })
      .from(schema.bankAccounts)
      .where(eq(schema.bankAccounts.id, run.bankAccountId))
      .limit(1),
    db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, 'payment_run'), eq(schema.auditLog.entityId, run.id)))
      .orderBy(schema.auditLog.timestamp),
  ]);
  const billById = new Map(bills.map((b) => [b.id, b]));
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const nameOf = (partyId: string) => partyById.get(partyId)?.displayName ?? partyId;

  // Backup withholding: the stored amount of a payment that exists, a preview for a vendor still to be paid.
  const open = (OPEN_RUN_STATUSES as readonly string[]).includes(run.status);
  const liveByParty = new Map(payments.filter((p) => !p.deletedAt).map((p) => [p.contactId, p]));
  const planned = open
    ? await computeRunWithholding(db, {
        entityId,
        method: run.method as RunMethod,
        paymentDate: run.paymentDate,
        items: items.filter((i) => !liveByParty.has(i.partyId)),
        parties,
      })
    : new Map<string, VendorWithholding>();

  const vendors: RunVendorView[] = [];
  let countedGross = 0;
  let countedWithheld = 0;
  for (const partyId of partyIds) {
    const own = items.filter((i) => i.partyId === partyId);
    const partyHolds = holds.filter((h) => h.partyId === partyId);
    const live = liveByParty.get(partyId);
    const payment = live ?? payments.find((p) => p.contactId === partyId);
    const gross = own.reduce((sum, i) => roundMoney(sum + i.amount), 0);
    const held = partyHolds.some((h) => !h.released);
    const preview = planned.get(partyId);
    const withheld = live ? Number.parseFloat(live.backupWithholdingAmount ?? '0') : (preview?.amount ?? 0);
    // What the run pays: the payments that exist, and while it is planned every vendor that is not held.
    if (live || (open && !held)) {
      countedGross = roundMoney(countedGross + (live ? Number.parseFloat(live.amount) : gross));
      countedWithheld = roundMoney(countedWithheld + withheld);
    }
    vendors.push({
      partyId,
      name: nameOf(partyId),
      amount: gross.toFixed(2),
      billCount: own.length,
      held,
      backupWithholding:
        withheld > 0
          ? {
              amount: withheld.toFixed(2),
              net: (live ? paymentNetAmount(live) : roundMoney(gross - withheld)).toFixed(2),
              reason: preview?.reason ?? null,
              rate: preview?.rate ?? BACKUP_WITHHOLDING_RATE,
            }
          : null,
      holds: partyHolds.map((h) => ({
        code: h.code,
        message: h.message,
        releasable: !releaseBlocker(h),
        released: h.released,
        blocker: releaseBlocker(h),
      })),
      payment: payment
        ? {
            id: payment.id,
            amount: payment.amount,
            backupWithholdingAmount: Number.parseFloat(payment.backupWithholdingAmount ?? '0') > 0 ? payment.backupWithholdingAmount : null,
            netAmount: paymentNetAmount(payment).toFixed(2),
            checkNumber: payment.checkNumber,
            checkStatus: payment.deletedAt ? 'voided' : payment.checkStatus,
            deleted: Boolean(payment.deletedAt),
          }
        : null,
    });
  }

  return {
    ...summarize(run, bank[0]?.name ?? null),
    bankAccount: bank[0] ? { id: bank[0].id, name: bank[0].name, accountNumberLast4: bank[0].last4 } : null,
    ...totalsOf(items, holds),
    withheldAmount: countedWithheld.toFixed(2),
    netAmount: roundMoney(countedGross - countedWithheld).toFixed(2),
    approvals: run.approvals ?? [],
    items: items.map((i) => {
      const bill = billById.get(i.billId);
      return {
        billId: i.billId,
        billNumber: bill?.billNumber ?? null,
        partyId: i.partyId,
        partyName: nameOf(i.partyId),
        amount: i.amount.toFixed(2),
        billTotal: bill?.total ?? null,
        balanceDue: bill?.balanceDue ?? null,
        dueDate: bill?.dueDate ?? null,
      };
    }),
    vendors,
    holds: holds.map((h) => ({
      partyId: h.partyId,
      partyName: nameOf(h.partyId),
      code: h.code,
      message: h.message,
      released: h.released,
      releasable: !releaseBlocker(h),
    })),
    history: history.map((h) => ({ action: h.action, userId: h.userId, at: h.timestamp, changes: h.changes })),
  };
}

// ---------------------------------------------------------------------------
// Bills that can go into a run

export interface PayableBillsFilter {
  entityId: string;
  /** Bills due on or before this day (YYYY-MM-DD). */
  dueBefore?: string;
  partyId?: string;
  /** Takes the hold window from this bank account's ACH settings. */
  bankAccountId?: string;
  now?: Date;
}

/** Approved bills with an open balance, by vendor, with each vendor's ACH readiness. */
export async function listPayableBills(db: Database, filter: PayableBillsFilter) {
  const now = filter.now ?? new Date();
  const conditions = [
    eq(schema.bills.entityId, filter.entityId),
    isNull(schema.bills.deletedAt),
    eq(schema.bills.type, 'standard'),
    inArray(schema.bills.status, [...PAYABLE_BILL_STATUSES]),
    sql`coalesce(${schema.bills.balanceDue}, '0')::numeric > 0`,
  ];
  if (filter.partyId) conditions.push(eq(schema.bills.contactId, filter.partyId));
  if (filter.dueBefore) conditions.push(sql`${schema.bills.dueDate} < (${filter.dueBefore}::date + interval '1 day')`);

  const bills = await db.select().from(schema.bills).where(and(...conditions)).orderBy(schema.bills.dueDate, schema.bills.id);
  if (bills.length === 0) return [];

  const partyIds = [...new Set(bills.map((b) => b.contactId))];
  const [parties, openRuns, history, bank] = await Promise.all([
    db.select().from(schema.parties).where(inArray(schema.parties.id, partyIds)),
    db
      .select({ id: schema.paymentRuns.id, items: schema.paymentRuns.items })
      .from(schema.paymentRuns)
      .where(
        and(
          eq(schema.paymentRuns.entityId, filter.entityId),
          isNull(schema.paymentRuns.deletedAt),
          inArray(schema.paymentRuns.status, [...OPEN_RUN_STATUSES]),
        ),
      ),
    loadAchHistory(db, filter.entityId, partyIds),
    filter.bankAccountId ? loadBankAccount(db, filter.entityId, filter.bankAccountId) : Promise.resolve(null),
  ]);
  const holdWindowDays = bank ? readAchSettings(bank.achSettings).holdWindowDays : DEFAULT_HOLD_WINDOW_DAYS;
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const billRun = new Map<string, string>();
  for (const run of openRuns) for (const item of run.items ?? []) billRun.set(item.billId, run.id);

  const vendors = [];
  for (const partyId of partyIds) {
    const party = partyById.get(partyId);
    const own = bills.filter((b) => b.contactId === partyId);
    const totalDue = own.reduce((sum, b) => roundMoney(sum + Number.parseFloat(b.balanceDue ?? '0')), 0);
    const ach = party ? vendorAchStatus(party, holdWindowDays, now) : null;
    const withholding =
      party?.is1099Vendor
        ? await computeBackupWithholding(db, { entityId: filter.entityId, partyId, grossAmount: totalDue, date: now })
        : null;
    vendors.push({
      partyId,
      name: party?.displayName ?? own[0]?.contactName ?? partyId,
      addressLines: party ? formatPostalAddressLines(party.billingAddress ? { country: 'US', ...party.billingAddress } : null, { omitCountry: 'US' }) : [],
      totalDue: totalDue.toFixed(2),
      ach: ach && party
        ? {
            ...ach,
            prenote: prenoteState(party, history.get(partyId) ?? { livePayments: [], prenotes: [] }, now),
            /** Payments wait for a manager to verify the changed bank details. */
            held: ach.holdActive,
          }
        : null,
      backupWithholding:
        withholding && withholding.amount > 0
          ? { applies: true, reason: withholding.reason, rate: withholding.rate, amount: withholding.amount.toFixed(2), net: withholding.net.toFixed(2) }
          : { applies: false },
      bills: own.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        reference: b.reference ?? b.externalReference,
        status: b.status,
        issueDate: b.issueDate,
        dueDate: b.dueDate,
        daysOverdue: Math.max(0, Math.floor((now.getTime() - b.dueDate.getTime()) / 86_400_000)),
        currency: b.currency,
        total: b.total,
        balanceDue: b.balanceDue,
        inOpenRunId: billRun.get(b.id) ?? null,
      })),
    });
  }
  return vendors.sort((a, b) => a.name.localeCompare(b.name));
}

