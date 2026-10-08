/**
 * Pure helpers of the vendor payment screens: which badge a status gets, what
 * the approval button does for the person looking at a run, and how a hold is
 * presented. No React here, so the rules can be tested on their own.
 */
import type {
  HoldCode,
  PaymentRunDetail,
  RunApproval,
  RunHoldView,
  RunStatus,
} from '@/lib/api/domains/weldbooks-payment-runs';

export type BadgeTone = 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive';

export function statusTone(status: RunStatus): BadgeTone {
  switch (status) {
    case 'draft':
      return 'secondary';
    case 'pending_approval':
      return 'warning';
    case 'approved':
    case 'exported':
      return 'default';
    case 'completed':
      return 'success';
    case 'cancelled':
      return 'outline';
  }
}

/** A run whose bills can still be changed: nothing has been paid yet. */
export function isRunOpen(status: RunStatus): boolean {
  return status === 'draft' || status === 'pending_approval';
}

/** Holds on bank details clear when the vendor is fixed or verified; they are never released from the run. */
export const BANK_DETAIL_HOLDS: readonly HoldCode[] = ['no_bank_details', 'invalid_bank_details', 'bank_details_changed'];

export function isBankDetailHold(code: HoldCode): boolean {
  return BANK_DETAIL_HOLDS.includes(code);
}

/**
 * Holds that are never released from the run. Backup withholding is one of them but only when the chart of
 * accounts has no Backup Withholding Payable account: otherwise the run takes the withholding out of the
 * payment and holds nobody. It clears when the account is added.
 */
export function isUnreleasableHold(code: HoldCode): boolean {
  return isBankDetailHold(code) || code === 'backup_withholding';
}

/** Where the way to fix a hold that can't be released starts: the vendor, or the chart of accounts. */
export function holdFixTarget(code: HoldCode): 'vendors' | 'chart' {
  return code === 'backup_withholding' ? 'chart' : 'vendors';
}

/** Holds that still keep their vendor out of the payments. */
export function activeHoldsOf(holds: readonly RunHoldView[]): RunHoldView[] {
  return holds.filter((hold) => !hold.released);
}

// ---------------------------------------------------------------------------
// Approval

export type ApprovalNote =
  /** The run is not waiting for approval. */
  | 'not_pending'
  | 'needs_permission'
  /** This person's approval is already recorded; a second approver has to be someone else. */
  | 'already_approved'
  /** The person who made the run may approve it, but never as the only approver. */
  | 'creator_first'
  /** Every approval is in but the payments were not made (an interrupted approval): approving again finishes it. */
  | 'finish';

export interface ApprovalState {
  /** What the button does: record an approval, finish an interrupted one, or nothing. */
  action: 'approve' | 'finish' | 'none';
  enabled: boolean;
  note: ApprovalNote | null;
  /** Approvals still missing. */
  remaining: number;
}

type ApprovalRun = Pick<PaymentRunDetail, 'status' | 'requiredApprovals' | 'createdBy'> & { approvals: readonly RunApproval[] };

/**
 * The approval button for the signed-in person. Approving takes `banking:manage`;
 * two approvals need two different people, so a person who already approved
 * can't approve again. The person who made the run can be one of the two but
 * not the only one (the server enforces it; here it only explains itself).
 * A run with all its approvals still pending approval is an interrupted
 * approval: any manager can finish it.
 */
export function approvalStateOf(run: ApprovalRun, userId: string | null | undefined, canManage: boolean): ApprovalState {
  if (run.status !== 'pending_approval') return { action: 'none', enabled: false, note: 'not_pending', remaining: 0 };

  const count = run.approvals.length;
  const remaining = Math.max(0, run.requiredApprovals - count);

  if (remaining === 0) {
    return { action: 'finish', enabled: canManage && !!userId, note: canManage ? 'finish' : 'needs_permission', remaining };
  }
  if (!canManage || !userId) return { action: 'approve', enabled: false, note: 'needs_permission', remaining };
  if (run.approvals.some((approval) => approval.userId === userId)) {
    return { action: 'approve', enabled: false, note: 'already_approved', remaining };
  }
  if (run.requiredApprovals > 1 && run.createdBy === userId && count === 0) {
    return { action: 'approve', enabled: true, note: 'creator_first', remaining };
  }
  return { action: 'approve', enabled: true, note: null, remaining };
}

// ---------------------------------------------------------------------------
// Dates

/** The date part of an ISO timestamp or date, for `formatDate`. */
export function dayOf(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}
