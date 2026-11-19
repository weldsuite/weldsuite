/**
 * Which actions a purchase order offers, from its status, the edition and
 * the user's permissions. Pure, so the rules are tested apart from the screen.
 *
 * Every edition: create, edit, delete and lines through the CRUD routes (and
 * a status chooser, since nothing else moves a status on Global). Kubernetes
 * editions only (the Rust backend's routes): approve, mark ordered, receive,
 * cancel, close, the receipts and Send to Odoo.
 *
 * An order sent to Odoo (`metadata.odoo`) is managed there: the backend
 * refuses every action on it, so the screen offers none.
 */

export interface PurchaseOrderActionContext {
  status: string;
  /** Total units received so far (a cancel needs none). */
  totalQuantityReceived: number;
  /** `metadata.odoo` is set: the order was sent to Odoo. */
  sentToOdoo: boolean;
  /** The order's warehouse has `managedByConnectionId`. */
  warehouseManagedInOdoo: boolean;
  /** The purchase-order lifecycle (`stash-replenishment`): approve, order, receive, cancel, close. Rust only. */
  purchasing: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface PurchaseOrderActions {
  edit: boolean;
  delete: boolean;
  /** Add, change and remove lines. */
  editLines: boolean;
  /** Global only: pick the status by hand in the edit form. */
  chooseStatus: boolean;
  approve: boolean;
  markOrdered: boolean;
  receive: boolean;
  cancel: boolean;
  close: boolean;
  sendToOdoo: boolean;
  /** Show the Receipts tab. */
  receipts: boolean;
}

export function isSentToOdoo(metadata: Record<string, unknown> | null | undefined): boolean {
  return !!metadata && typeof metadata === 'object' && metadata.odoo !== undefined && metadata.odoo !== null;
}

export function purchaseOrderActions(ctx: PurchaseOrderActionContext): PurchaseOrderActions {
  const { status, purchasing, canUpdate } = ctx;
  const managed = ctx.sentToOdoo;
  const mutable = canUpdate && !managed;
  const draftish = status === 'draft' || status === 'pending';

  return {
    edit: mutable && (!purchasing || draftish || status === 'approved'),
    delete: ctx.canDelete && !managed && (!purchasing || draftish || status === 'cancelled'),
    editLines: mutable && (!purchasing || draftish),
    chooseStatus: mutable && !purchasing,
    approve: purchasing && mutable && draftish,
    markOrdered: purchasing && mutable && status === 'approved',
    receive: purchasing && mutable && (status === 'approved' || status === 'ordered' || status === 'partial'),
    cancel:
      purchasing &&
      mutable &&
      (draftish || status === 'approved' || status === 'ordered') &&
      ctx.totalQuantityReceived === 0,
    close: purchasing && mutable && (status === 'partial' || status === 'received'),
    sendToOdoo:
      purchasing && mutable && ctx.warehouseManagedInOdoo && (draftish || status === 'approved'),
    receipts: purchasing,
  };
}

/** Badge tone per status, for `SoftBadge`. */
export function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'approved':
    case 'ordered':
    case 'received':
      return 'success';
    case 'partial':
    case 'pending':
      return 'warning';
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** What is still to receive on a line: ordered less received and rejected, never below zero. */
export function remainingToReceive(line: {
  quantityOrdered: number;
  quantityReceived?: number | null;
  quantityRejected?: number | null;
}): number {
  return Math.max(line.quantityOrdered - (line.quantityReceived ?? 0) - (line.quantityRejected ?? 0), 0);
}
