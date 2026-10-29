/**
 * Approvals an agent attached to its channel message.
 *
 * When an agent's turn parks an action for a human (`Create task "…"`), the
 * message carries `metadata.approvals`; the chat shows each as a small card
 * with Approve / Reject. The field is optional and written by another service,
 * so it is read defensively.
 */

export interface MessageApproval {
  id: string;
  /** Human text for the parked action, e.g. `Create task "QA agent chat task"`. */
  label: string;
  /** `pending` when the message was written; a later write may change it. */
  status: string;
}

/** Where an approval stands, as its card tells it. */
export type ApprovalCardState = 'waiting' | 'approved' | 'rejected' | 'handled';

/**
 * A pending list read before an approval existed does not contain it yet. An
 * approval younger than this is never called "handled" from a list alone.
 */
export const FRESH_APPROVAL_MS = 2 * 60_000;

const MAX_APPROVALS = 20;

/** The approvals on a message's metadata; empty when there are none or the shape is off. */
export function readMessageApprovals(metadata: unknown): MessageApproval[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const raw = (metadata as { approvals?: unknown }).approvals;
  if (!Array.isArray(raw)) return [];

  const approvals: MessageApproval[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, label, status } = entry as { id?: unknown; label?: unknown; status?: unknown };
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    approvals.push({
      id,
      label: typeof label === 'string' ? label : '',
      status: typeof status === 'string' ? status : 'pending',
    });
    if (approvals.length >= MAX_APPROVALS) break;
  }
  return approvals;
}

interface ApprovalStateInput {
  approval: MessageApproval;
  /** What this browser just did with it, before the server's own record catches up. */
  local: 'approved' | 'rejected' | 'handled' | null;
  /** Ids of the agent's still-pending approvals, or null until that list has been read. */
  pending: ReadonlySet<string> | null;
  /** When the agent asked (the message's timestamp). */
  askedAt?: string | null;
  now?: number;
}

export function approvalCardState({ approval, local, pending, askedAt, now = Date.now() }: ApprovalStateInput): ApprovalCardState {
  if (local) return local;
  if (approval.status === 'approved' || approval.status === 'rejected') return approval.status;
  // `expired`, `auto_approved`, … : not waiting for anyone.
  if (approval.status !== 'pending') return 'handled';
  if (pending === null || pending.has(approval.id)) return 'waiting';

  const askedMs = askedAt ? Date.parse(askedAt) : Number.NaN;
  const fresh = Number.isFinite(askedMs) && Math.abs(now - askedMs) < FRESH_APPROVAL_MS;
  return fresh ? 'waiting' : 'handled';
}
