import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';

/** Statuses of a bill that is booked and not settled yet: money can be paid out against it. */
const PAYABLE_STATUSES = new Set(['approved', 'posted', 'partial', 'overdue']);

type BillState = Pick<BillWithTax, 'status' | 'approvalStatus' | 'balanceDue'>;

/** Whether a payment can be recorded against the bill now: it is approved (posted) and has a balance due. */
export function canRecordBillPayment(bill: BillState): boolean {
  if (!(Number(bill.balanceDue ?? 0) > 0)) return false;
  if (bill.approvalStatus === 'pending' || bill.approvalStatus === 'rejected') return false;
  return PAYABLE_STATUSES.has(bill.status);
}

/** Whether the bill is past its due date with money still owed: the only time its balance is a warning. */
export function isBillOverdue(bill: BillState & Pick<BillWithTax, 'dueDate'>, today = new Date()): boolean {
  if (!canRecordBillPayment(bill)) return false;
  if (bill.status === 'overdue') return true;
  const due = bill.dueDate?.slice(0, 10);
  return !!due && due < today.toISOString().slice(0, 10);
}
