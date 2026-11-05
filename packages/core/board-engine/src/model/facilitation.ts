/**
 * Facilitation, as board state everyone in the room shares: a timer, a
 * voting round and private mode. Each change is an op (`setBoard` for the
 * board's properties, `vote` for one person's votes), so it orders, undoes
 * and survives a reload like any edit.
 *
 *   - Timer: running (`endsAt`) or paused (`remaining`). Every client counts
 *     down from the same `endsAt`, so they agree without ticking the room.
 *   - Voting: a round with a number of votes per person, optionally anonymous
 *     and limited to some elements. A person's votes are a list of element
 *     ids (repeats allowed). Closing the round shows the result; clearing it
 *     takes the votes away.
 *   - Private mode: stickies of others show as covered until it ends.
 */

import type { Board } from './board';
import type { BoardElement, BoardTimer, VotingSession } from './types';
import type { Op } from '../ops/types';

/** Longest timer, ms (two hours). */
export const MAX_TIMER_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------- timer

/** Time left, ms (0 when done or there is no timer). */
export function timerRemaining(timer: BoardTimer | null | undefined, now: number): number {
  if (!timer) return 0;
  if (timer.endsAt !== undefined) return Math.max(0, timer.endsAt - now);
  return Math.max(0, timer.remaining ?? timer.duration);
}

export function timerRunning(timer: BoardTimer | null | undefined): boolean {
  return !!timer && timer.endsAt !== undefined;
}

export function startTimerOp(duration: number, now: number, userId?: string): Op {
  const d = Math.round(Math.min(MAX_TIMER_MS, Math.max(1000, duration)));
  const timer: BoardTimer = { duration: d, endsAt: now + d, ...(userId ? { startedBy: userId } : {}) };
  return { type: 'setBoard', patch: { timer } };
}

export function pauseTimerOp(timer: BoardTimer, now: number): Op {
  const { endsAt: _endsAt, ...rest } = timer;
  return { type: 'setBoard', patch: { timer: { ...rest, remaining: timerRemaining(timer, now) } } };
}

export function resumeTimerOp(timer: BoardTimer, now: number): Op {
  const { remaining, ...rest } = timer;
  return { type: 'setBoard', patch: { timer: { ...rest, endsAt: now + Math.max(0, remaining ?? timer.duration) } } };
}

/** Adds (or with a negative `ms`, takes away) time from a timer. */
export function addTimeOp(timer: BoardTimer, ms: number, now: number): Op {
  if (timer.endsAt !== undefined) {
    const endsAt = Math.min(now + MAX_TIMER_MS, Math.max(now, timer.endsAt + ms));
    return { type: 'setBoard', patch: { timer: { ...timer, endsAt, duration: Math.min(MAX_TIMER_MS, Math.max(1000, timer.duration + ms)) } } };
  }
  const remaining = Math.min(MAX_TIMER_MS, Math.max(0, (timer.remaining ?? timer.duration) + ms));
  return { type: 'setBoard', patch: { timer: { ...timer, remaining } } };
}

export function stopTimerOp(): Op {
  return { type: 'setBoard', patch: { timer: null } };
}

// ---------------------------------------------------------------- voting

/** Element types a round counts when it is not limited to some elements. */
const VOTABLE = new Set<BoardElement['type']>(['sticky', 'shape', 'card', 'image', 'record', 'link', 'text', 'file']);

/** Whether `el` may be voted on in `session`. */
export function canVoteOn(session: VotingSession | null | undefined, el: BoardElement | undefined): boolean {
  if (!session || session.status !== 'open' || !el) return false;
  return session.scope ? session.scope.includes(el.id) : VOTABLE.has(el.type);
}

/** Starts a round, taking away the votes of the last one. */
export function startVotingOp(
  board: Board,
  session: Pick<VotingSession, 'votesPerPerson' | 'anonymous'> & Partial<Pick<VotingSession, 'scope' | 'title'>>,
  id: string,
  userId?: string,
): Op {
  const voting: VotingSession = {
    id,
    votesPerPerson: Math.min(100, Math.max(1, Math.round(session.votesPerPerson))),
    anonymous: session.anonymous,
    status: 'open',
    ...(session.scope?.length ? { scope: session.scope.slice(0, 5000) } : {}),
    ...(session.title ? { title: session.title.slice(0, 200) } : {}),
    ...(userId ? { startedBy: userId } : {}),
  };
  return { type: 'batch', ops: [...clearVoteOps(board), { type: 'setBoard', patch: { voting } }] };
}

/** `userId`'s votes after adding one for `elementId` (or taking one back); null when nothing changes. */
export function castVoteOp(board: Board, userId: string, elementId: string, take = false): Op | null {
  const session = board.props.voting;
  if (!canVoteOn(session, board.get(elementId))) return null;
  const mine = [...(board.votes.get(userId) ?? [])];
  if (take) {
    const at = mine.lastIndexOf(elementId);
    if (at < 0) return null;
    mine.splice(at, 1);
  } else {
    if (mine.length >= session!.votesPerPerson) return null;
    mine.push(elementId);
  }
  return { type: 'vote', user: userId, elements: mine.length ? mine : null };
}

/** Votes `userId` has left in the open round. */
export function votesLeft(board: Board, userId: string): number {
  const session = board.props.voting;
  if (!session || session.status !== 'open') return 0;
  return Math.max(0, session.votesPerPerson - (board.votes.get(userId)?.length ?? 0));
}

/** Votes per element, counting every person's (votes for removed elements left out). */
export function voteCounts(board: Board): Map<string, number> {
  const out = new Map<string, number>();
  for (const ids of board.votes.values()) for (const id of ids) if (board.get(id)) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** Ends the round: votes are kept and shown. */
export function closeVotingOp(board: Board): Op | null {
  const session = board.props.voting;
  if (!session || session.status !== 'open') return null;
  return { type: 'setBoard', patch: { voting: { ...session, status: 'closed' } } };
}

/** Ends the round and takes every vote away. */
export function clearVotingOp(board: Board): Op {
  return { type: 'batch', ops: [...clearVoteOps(board), { type: 'setBoard', patch: { voting: null } }] };
}

function clearVoteOps(board: Board): Op[] {
  return [...board.votes.keys()].sort().map((user) => ({ type: 'vote' as const, user, elements: null }));
}

// ---------------------------------------------------------------- private mode

export function privateModeOp(on: boolean): Op {
  return { type: 'setBoard', patch: { privateMode: on } };
}
