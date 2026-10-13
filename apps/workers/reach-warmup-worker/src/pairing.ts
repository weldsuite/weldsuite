/**
 * Who emails whom (docs/plans/weldreach-warmup.md, "Pairing").
 *
 * Pure: the planner loads the pool and the recent history, this picks one
 * recipient per message and keeps the running tallies.
 *
 * One rule is absolute: never within one domain. The rest are preferences, so a
 * small pool still gets a recipient for every message:
 *
 *   1. a pair that has not had a new thread in the last 3 days (cool-down);
 *   2. spread over as many other domains as possible (fewest uses today);
 *   3. other workspace, other mailbox type, and the recipient that has received
 *      the least compared with what it sends (balance).
 *
 * Balance also acts as a soft cap: a recipient already well past what it will
 * send today is skipped while anyone else is available, so received stays
 * roughly equal to sent.
 */

import type { Rng } from './lib/random';

export interface PairingMailbox {
  id: string;
  workspaceId: string;
  domain: string;
  mailboxType: string;
  /** What this mailbox sends today (or would, once planned): the balance reference. */
  capacity: number;
}

export interface PairingState {
  /** Warmup mail already planned to each mailbox in the balance window. */
  received: Map<string, number>;
  /** `pairKey`s that had a new thread within the cool-down. */
  coolingPairs: Set<string>;
  /** How many of today's messages this sender already aimed at each domain. */
  domainUses: Map<string, number>;
}

/** Penalties: lower total is better. The gaps keep the order described above. */
export const PAIRING_WEIGHTS = {
  /** The pair had a thread within the cool-down. */
  cooling: 1000,
  /** Per message already aimed at the recipient's domain today. */
  domainUse: 100,
  sameWorkspace: 30,
  sameType: 20,
  /** Times the recipient's fill (received / capacity), so a fuller one scores worse. */
  balance: 40,
  /** Random tie-break, from 0 up to this. */
  jitter: 10,
} as const;

/** A recipient may receive up to this share above its capacity (plus one) before it is skipped. */
export const RECEIVE_HEADROOM = 1.25;

/** Order-independent key of two mailboxes. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function createPairingState(
  received: Map<string, number>,
  coolingPairs: Set<string>,
): PairingState {
  return { received, coolingPairs, domainUses: new Map() };
}

function receivedBy(state: PairingState, id: string): number {
  return state.received.get(id) ?? 0;
}

function hasHeadroom(state: PairingState, candidate: PairingMailbox): boolean {
  const limit = Math.ceil(Math.max(1, candidate.capacity) * RECEIVE_HEADROOM) + 1;
  return receivedBy(state, candidate.id) < limit;
}

function score(sender: PairingMailbox, candidate: PairingMailbox, state: PairingState, rng: Rng): number {
  const weights = PAIRING_WEIGHTS;
  let penalty = 0;
  if (state.coolingPairs.has(pairKey(sender.id, candidate.id))) penalty += weights.cooling;
  penalty += (state.domainUses.get(candidate.domain) ?? 0) * weights.domainUse;
  if (candidate.workspaceId === sender.workspaceId) penalty += weights.sameWorkspace;
  if (candidate.mailboxType === sender.mailboxType) penalty += weights.sameType;
  const fill = (receivedBy(state, candidate.id) + 1) / Math.max(1, candidate.capacity);
  penalty += Math.min(fill, 3) * weights.balance;
  return penalty + rng() * weights.jitter;
}

/**
 * The best recipient for one more message from `sender`, or null when the pool
 * has nobody on another domain. Records the pick in `state`.
 */
export function pickRecipient(
  sender: PairingMailbox,
  pool: readonly PairingMailbox[],
  state: PairingState,
  rng: Rng,
): PairingMailbox | null {
  const otherDomains = pool.filter((candidate) => candidate.id !== sender.id && candidate.domain !== sender.domain);
  if (otherDomains.length === 0) return null;
  const withRoom = otherDomains.filter((candidate) => hasHeadroom(state, candidate));
  const candidates = withRoom.length > 0 ? withRoom : otherDomains;

  let best: PairingMailbox | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateScore = score(sender, candidate, state, rng);
    if (candidateScore < bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  if (best) recordPick(sender, best, state);
  return best;
}

export function recordPick(sender: PairingMailbox, recipient: PairingMailbox, state: PairingState): void {
  state.received.set(recipient.id, receivedBy(state, recipient.id) + 1);
  state.domainUses.set(recipient.domain, (state.domainUses.get(recipient.domain) ?? 0) + 1);
  state.coolingPairs.add(pairKey(sender.id, recipient.id));
}

/**
 * A corpus thread the pair has not used recently, preferring the one this run
 * has used least; falls back to any thread when the pair has seen them all.
 */
export function pickThreadId(
  threadIds: readonly string[],
  usedByPair: ReadonlySet<string>,
  usedThisRun: Map<string, number>,
  rng: Rng,
): string | null {
  if (threadIds.length === 0) return null;
  const fresh = threadIds.filter((id) => !usedByPair.has(id));
  const pool = fresh.length > 0 ? fresh : threadIds;
  let lowest = Number.POSITIVE_INFINITY;
  for (const id of pool) lowest = Math.min(lowest, usedThisRun.get(id) ?? 0);
  const least = pool.filter((id) => (usedThisRun.get(id) ?? 0) === lowest);
  const chosen = least[Math.min(least.length - 1, Math.floor(rng() * least.length))] ?? null;
  if (chosen) usedThisRun.set(chosen, (usedThisRun.get(chosen) ?? 0) + 1);
  return chosen;
}
