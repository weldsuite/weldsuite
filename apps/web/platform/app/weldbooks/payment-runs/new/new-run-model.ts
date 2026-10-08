/**
 * The planning rules of the new payment run wizard, free of React: which
 * vendors and bills can be picked, what the amounts are, what a run created
 * from the picks looks like, and what the review step has to warn about.
 *
 * A vendor with a hard hold (no usable bank details, or bank details that
 * changed and are not verified) is blocked for ACH: the server would leave it
 * out of the payments, so the wizard never lets it into the run. A bill that
 * is already in another open run is blocked for the same reason. Prenotes
 * only warn: a manager can release that hold.
 *
 * Backup withholding is no hold. The run takes the 24% out of the payment: the
 * bills settle for the gross, the vendor is paid the net. The wizard shows it
 * as figures (gross, withheld, net) worked out from the amounts picked, the way
 * the server does; the server works them out again when the payment is made.
 */
import { isLiabilityAccountType } from '@/lib/api/domains/weldbooks-banking';
import type {
  AchSecCode,
  BackupWithholdingReason,
  CreateRunInput,
  PayableBill,
  PayableVendor,
  RunItemInput,
  RunMethod,
} from '@/lib/api/domains/weldbooks-payment-runs';

export type BlockReason = 'no_bank_details' | 'invalid_bank_details' | 'bank_details_changed' | 'in_open_run';
export type VendorWarning = 'prenote_needed' | 'prenote_pending';

/** A bill's pick: whether it is in the run and the amount typed for it. */
export interface BillPick {
  selected: boolean;
  /** As typed; parsed when the run is built. */
  amount: string;
}
export type PickMap = Readonly<Record<string, BillPick>>;

const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (cents: number): number => cents / 100;

/** `12.5` becomes `12.50`. */
export function moneyText(value: number | string | null | undefined): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

/** A positive amount with at most two decimals, or null. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  return n > 0 ? n : null;
}

export function balanceOf(bill: Pick<PayableBill, 'balanceDue'>): number {
  const n = Number.parseFloat(bill.balanceDue ?? '0');
  return Number.isFinite(n) ? n : 0;
}

/** Bank accounts a vendor payment can come from: not cards or credit lines, not inactive. */
export function isPaymentBankAccount(account: { isActive?: boolean | null; accountType?: string | null }): boolean {
  return account.isActive !== false && !isLiabilityAccountType(account.accountType);
}

// ---------------------------------------------------------------------------
// Blocks and warnings

/** Why no bill of this vendor can go into an ACH run; null when it can (and for any check run). */
export function vendorBlock(vendor: Pick<PayableVendor, 'ach'>, method: RunMethod): BlockReason | null {
  if (method !== 'ach') return null;
  const ach = vendor.ach;
  if (!ach || !ach.hasRouting || !ach.hasAccount || !ach.hasAccountType) return 'no_bank_details';
  if (!ach.routingValid) return 'invalid_bank_details';
  if (ach.held || ach.holdActive) return 'bank_details_changed';
  return null;
}

export function billBlock(bill: Pick<PayableBill, 'inOpenRunId'>): BlockReason | null {
  return bill.inOpenRunId ? 'in_open_run' : null;
}

/** The first reason a bill can't be picked, or null. */
export function blockOf(vendor: Pick<PayableVendor, 'ach'>, bill: Pick<PayableBill, 'inOpenRunId'>, method: RunMethod): BlockReason | null {
  return vendorBlock(vendor, method) ?? billBlock(bill);
}

/** What the person should know before picking this vendor: the holds the run would put on it. */
export function vendorWarnings(
  vendor: Pick<PayableVendor, 'ach'>,
  method: RunMethod,
  options: { requirePrenotes: boolean },
): VendorWarning[] {
  const warnings: VendorWarning[] = [];
  if (method === 'ach' && options.requirePrenotes && !vendorBlock(vendor, method)) {
    if (vendor.ach?.prenote === 'needed') warnings.push('prenote_needed');
    else if (vendor.ach?.prenote === 'pending') warnings.push('prenote_pending');
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Backup withholding

export interface WithholdingPreview {
  /** Dollars kept back. */
  withheld: number;
  /** Dollars the vendor is paid. */
  net: number;
  reason: BackupWithholdingReason | null;
  /** 0.24 */
  rate: number;
}

/**
 * What backup withholding takes from `grossCents` paid to the vendor, worked out the way the server does
 * (the rate in whole cents, half a cent rounded up). Null when the vendor is not subject to it or
 * nothing is paid. The server also looks at the year's reporting threshold when the payment is made,
 * so this is the figure to expect, not a promise.
 */
export function withholdingPreview(vendor: Pick<PayableVendor, 'backupWithholding'>, grossCents: number): WithholdingPreview | null {
  const bw = vendor.backupWithholding;
  if (!bw.applies || !(grossCents > 0)) return null;
  const percent = Math.round(bw.rate * 100);
  const withheldCents = Math.floor((grossCents * percent + 50) / 100);
  if (withheldCents <= 0) return null;
  return { withheld: fromCents(withheldCents), net: fromCents(grossCents - withheldCents), reason: bw.reason, rate: bw.rate };
}

// ---------------------------------------------------------------------------
// Picks

/** Nothing picked; every bill starts at its open balance. */
export function emptyPicks(vendors: readonly PayableVendor[]): PickMap {
  const picks: Record<string, BillPick> = {};
  for (const vendor of vendors) {
    for (const bill of vendor.bills) picks[bill.id] = { selected: false, amount: moneyText(bill.balanceDue) };
  }
  return picks;
}

/** Keeps the picks of bills still on offer and adds the new ones unpicked. */
export function reconcilePicks(vendors: readonly PayableVendor[], previous: PickMap): PickMap {
  const fresh = emptyPicks(vendors);
  const next: Record<string, BillPick> = {};
  for (const id of Object.keys(fresh)) next[id] = previous[id] ?? fresh[id]!;
  return next;
}

export function setPicked(picks: PickMap, billId: string, selected: boolean): PickMap {
  const current = picks[billId];
  return current ? { ...picks, [billId]: { ...current, selected } } : picks;
}

export function setAmount(picks: PickMap, billId: string, amount: string): PickMap {
  const current = picks[billId];
  return current ? { ...picks, [billId]: { ...current, amount } } : picks;
}

/** Picks (or clears) every bill of a vendor that can be picked. */
export function setVendorPicked(picks: PickMap, vendor: PayableVendor, method: RunMethod, selected: boolean): PickMap {
  const next: Record<string, BillPick> = { ...picks };
  for (const bill of vendor.bills) {
    const current = next[bill.id];
    if (current && (!selected || !blockOf(vendor, bill, method))) next[bill.id] = { ...current, selected };
  }
  return next;
}

/** Drops picks that became blocked, e.g. after the method switched to ACH. */
export function dropBlockedPicks(picks: PickMap, vendors: readonly PayableVendor[], method: RunMethod): PickMap {
  const next: Record<string, BillPick> = { ...picks };
  for (const vendor of vendors) {
    for (const bill of vendor.bills) {
      const current = next[bill.id];
      if (current?.selected && blockOf(vendor, bill, method)) next[bill.id] = { ...current, selected: false };
    }
  }
  return next;
}

export type AmountProblem = 'invalid' | 'exceeds_balance';

/** What is wrong with the amount typed for a bill, or null. */
export function amountProblem(bill: Pick<PayableBill, 'balanceDue'>, text: string): AmountProblem | null {
  const amount = parseAmount(text);
  if (amount === null) return 'invalid';
  return toCents(amount) > toCents(balanceOf(bill)) ? 'exceeds_balance' : null;
}

// ---------------------------------------------------------------------------
// The run

export interface BuiltItems {
  items: RunItemInput[];
  /** Dollars the run's bills settle for. */
  total: number;
  /** Backup withholding kept back from `total`, dollars. */
  withheld: number;
  /** What leaves the bank: `total` less `withheld`. */
  net: number;
  vendorCount: number;
  /** Picked bills whose amount can't be used. */
  problems: Array<{ billId: string; problem: AmountProblem }>;
  /** What is picked of each vendor, in cents, and what backup withholding takes from it. */
  byVendor: Readonly<Record<string, { grossCents: number; withholding: WithholdingPreview | null }>>;
}

/** The items of the run: every picked bill that can be picked, with its parsed amount, in the order shown. */
export function buildItems(vendors: readonly PayableVendor[], picks: PickMap, method: RunMethod): BuiltItems {
  const items: RunItemInput[] = [];
  const problems: BuiltItems['problems'] = [];
  const picked = new Map<string, number>();
  let cents = 0;

  for (const vendor of vendors) {
    for (const bill of vendor.bills) {
      const pick = picks[bill.id];
      if (!pick?.selected || blockOf(vendor, bill, method)) continue;
      const problem = amountProblem(bill, pick.amount);
      if (problem) {
        problems.push({ billId: bill.id, problem });
        continue;
      }
      const amount = parseAmount(pick.amount) as number;
      items.push({ billId: bill.id, amount });
      cents += toCents(amount);
      picked.set(vendor.partyId, (picked.get(vendor.partyId) ?? 0) + toCents(amount));
    }
  }

  const byVendor: Record<string, { grossCents: number; withholding: WithholdingPreview | null }> = {};
  let withheldCents = 0;
  for (const vendor of vendors) {
    const grossCents = picked.get(vendor.partyId);
    if (grossCents === undefined) continue;
    const withholding = withholdingPreview(vendor, grossCents);
    byVendor[vendor.partyId] = { grossCents, withholding };
    if (withholding) withheldCents += toCents(withholding.withheld);
  }
  return {
    items,
    total: fromCents(cents),
    withheld: fromCents(withheldCents),
    net: fromCents(cents - withheldCents),
    vendorCount: picked.size,
    problems,
    byVendor,
  };
}

export interface RunPlanOptions {
  bankAccountId: string;
  method: RunMethod;
  /** YYYY-MM-DD */
  paymentDate: string;
  /** ACH: `auto` leaves the choice to the server (PPD for individuals, the bank account's default for businesses). */
  secCode: AchSecCode | 'auto';
  sameDay: boolean;
  requiredApprovals: 1 | 2;
  notes: string;
}

/** The request that creates the run; ACH-only options are left out of a check run. */
export function buildCreateInput(options: RunPlanOptions, items: RunItemInput[]): CreateRunInput {
  const notes = options.notes.trim();
  return {
    bankAccountId: options.bankAccountId,
    method: options.method,
    paymentDate: options.paymentDate,
    items,
    requiredApprovals: options.requiredApprovals,
    ...(notes ? { notes } : {}),
    ...(options.method === 'ach'
      ? { secCode: options.secCode === 'auto' ? null : options.secCode, sameDay: options.sameDay }
      : {}),
  };
}

/** Two approvals for ACH (the fraud-monitoring default), one for checks. */
export function defaultApprovals(method: RunMethod): 1 | 2 {
  return method === 'ach' ? 2 : 1;
}

export interface ReviewVendor {
  partyId: string;
  name: string;
  billCount: number;
  /** Dollars the vendor's bills settle for. */
  amount: number;
  /** Backup withholding kept back from `amount`; null when none applies. */
  withholding: WithholdingPreview | null;
  /** What the vendor is paid. */
  net: number;
  warnings: VendorWarning[];
}

/** The review step: one row per vendor with what is picked of it. */
export function reviewVendors(
  vendors: readonly PayableVendor[],
  picks: PickMap,
  method: RunMethod,
  options: { requirePrenotes: boolean },
): ReviewVendor[] {
  const rows: ReviewVendor[] = [];
  for (const vendor of vendors) {
    let billCount = 0;
    let cents = 0;
    for (const bill of vendor.bills) {
      const pick = picks[bill.id];
      if (!pick?.selected || blockOf(vendor, bill, method)) continue;
      const amount = parseAmount(pick.amount);
      if (amount === null || amountProblem(bill, pick.amount)) continue;
      billCount += 1;
      cents += toCents(amount);
    }
    if (billCount > 0) {
      const withholding = withholdingPreview(vendor, cents);
      rows.push({
        partyId: vendor.partyId,
        name: vendor.name,
        billCount,
        amount: fromCents(cents),
        withholding,
        net: withholding ? withholding.net : fromCents(cents),
        warnings: vendorWarnings(vendor, method, options),
      });
    }
  }
  return rows;
}
