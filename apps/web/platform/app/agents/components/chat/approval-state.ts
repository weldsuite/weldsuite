import type { DecidedApprovals } from '@/hooks/queries/use-agent-parity-queries';

/** Where an approval an agent asked for stands, as the chat tells it. */
export type ApprovalState = 'waiting' | 'approved' | 'rejected' | 'handled';

/** An approval this young may simply not be in a list that was read before it existed. */
export const FRESH_APPROVAL_MS = 2 * 60_000;

export function approvalStateOf(
  approvalId: string,
  pending: ReadonlySet<string>,
  decided: DecidedApprovals | undefined,
  askedAt: string,
  now: number = Date.now(),
): ApprovalState {
  if (pending.has(approvalId)) return 'waiting';
  const outcome = decided?.[approvalId];
  if (outcome) return outcome;
  // Not pending, and not known to be decided: either the lists have not caught
  // up yet, or it ended another way (expired, auto-approved).
  const askedMs = Date.parse(askedAt);
  const fresh = Number.isFinite(askedMs) && Math.abs(now - askedMs) < FRESH_APPROVAL_MS;
  return decided === undefined || fresh ? 'waiting' : 'handled';
}
