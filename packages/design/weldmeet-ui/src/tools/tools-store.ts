/**
 * Shared state for the meeting tools that have no server of their own: the
 * countdown timer, Q&A and breakout rooms.
 *
 * Everything travels over RealtimeKit's `participants.broadcastMessage`, the
 * same channel hand-raise and the host-control policy use, so it works for
 * signed-in members and meeting-portal guests alike without an extra worker.
 * A broadcast only reaches people who are in the room at that moment, so a
 * client that joins later asks for a snapshot (`sync-request`) and anyone
 * holding state answers.
 *
 * One store exists per RealtimeKit client and lives as long as that client.
 * The room view remounts when the meeting moves between the inline page and
 * the fullscreen overlay; keeping the state here (not in component state)
 * means a running timer or an open breakout survives that.
 *
 * Like the rest of the in-call policy, who may do what is enforced by the UI:
 * a message is taken at face value, because RealtimeKit does not tell the
 * receiver who sent it.
 */
import type { MeetingClient } from '../types';
import { randomIdSuffix } from '../lib/random-id';

const MSG = {
  timer: 'call:tools:timer',
  question: 'call:tools:question',
  vote: 'call:tools:vote',
  breakout: 'call:tools:breakout',
  syncRequest: 'call:tools:sync-request',
  sync: 'call:tools:sync',
} as const;

const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const MAX_QUESTIONS = 200;
const MAX_QUESTION_LENGTH = 500;
const MAX_NAME_LENGTH = 80;
const MAX_ROOMS = 20;
const MAX_ROOM_MEMBERS = 500;
/** How long the "Time's up" cue stays on screen after the countdown ends. */
export const TIMER_ENDED_CUE_MS = 10_000;

// ─── State ───────────────────────────────────────────────────────────────────

export type TimerStatus = 'idle' | 'running' | 'paused';

export interface TimerState {
  status: TimerStatus;
  /** Bumped on every change; the highest revision wins on every client. */
  rev: number;
  /** Participant key of whoever made the last change (revision tie-break). */
  by: string;
  durationMs: number;
  /** Time left while paused. While running, read {@link timerRemainingMs}. */
  remainingMs: number;
  /** Deadline on THIS client's clock while running. */
  endsAt: number | null;
  /** When the countdown reached zero on this client; drives the "Time's up" cue. */
  endedAt: number | null;
}

export interface QaVote {
  on: boolean;
  rev: number;
}

export interface QaQuestion {
  id: string;
  text: string;
  authorKey: string;
  authorName: string;
  askedAt: number;
  /** Revision of the answered / deleted flags. */
  rev: number;
  answered: boolean;
  /** Removed questions stay as tombstones so a late snapshot cannot revive them. */
  deleted: boolean;
  votes: Record<string, QaVote>;
}

export interface BreakoutRoom {
  id: string;
  name: string;
  /** Participant keys, see {@link participantKey}. */
  members: string[];
}

export interface BreakoutState {
  active: boolean;
  rev: number;
  by: string;
  rooms: BreakoutRoom[];
}

/** Choices that only affect this viewer; never broadcast. */
export interface ToolsPrefs {
  /** Show captions on this viewer's screen, whatever the host policy says. */
  captions: boolean;
  /** Play the tones on this viewer's device when the countdown ends. */
  timerSound: boolean;
  translationEnabled: boolean;
  /** BCP 47 codes of the spoken language and the language to read it in. */
  translateFrom: string;
  translateTo: string;
}

export interface MeetingToolsState {
  timer: TimerState;
  questions: QaQuestion[];
  breakout: BreakoutState;
  prefs: ToolsPrefs;
}

export type MeetingToolsEvent =
  | { type: 'timer-started'; durationMs: number }
  | { type: 'timer-ended' }
  | { type: 'question-asked'; question: QaQuestion }
  | { type: 'breakout-room-changed'; roomName: string | null; active: boolean };

function defaultTargetLanguage(): string {
  const lang = typeof navigator === 'undefined' ? '' : navigator.language;
  return lang ? lang.split('-')[0]!.toLowerCase() : 'en';
}

export function createInitialToolsState(): MeetingToolsState {
  return {
    timer: { status: 'idle', rev: 0, by: '', durationMs: 0, remainingMs: 0, endsAt: null, endedAt: null },
    questions: [],
    breakout: { active: false, rev: 0, by: '', rooms: [] },
    prefs: { captions: false, timerSound: true, translationEnabled: false, translateFrom: 'en', translateTo: defaultTargetLanguage() },
  };
}

// ─── Selectors ───────────────────────────────────────────────────────────────

/**
 * Stable identity of a participant across reconnects. RealtimeKit hands out a
 * new peer `id` on every (re)join, so room membership and votes are keyed by
 * the app-provided id instead and only fall back to the peer id.
 */
export function participantKey(
  peer: { id?: string; userId?: string; customParticipantId?: string } | null | undefined,
): string {
  return peer?.customParticipantId || peer?.userId || peer?.id || '';
}

export function timerRemainingMs(timer: TimerState, now: number = Date.now()): number {
  if (timer.status === 'running' && timer.endsAt !== null) return Math.max(0, timer.endsAt - now);
  if (timer.status === 'paused') return timer.remainingMs;
  return 0;
}

export function questionVoteCount(question: QaQuestion): number {
  let count = 0;
  for (const vote of Object.values(question.votes)) if (vote.on) count += 1;
  return count;
}

/** Open questions first (most upvoted, then oldest), answered ones after. */
export function sortedQuestions(questions: QaQuestion[]): QaQuestion[] {
  return questions
    .filter((q) => !q.deleted)
    .sort((a, b) => {
      if (a.answered !== b.answered) return a.answered ? 1 : -1;
      const votes = questionVoteCount(b) - questionVoteCount(a);
      return votes !== 0 ? votes : a.askedAt - b.askedAt;
    });
}

/** The room a participant sits in, or null for the main room. */
export function breakoutRoomOf(breakout: BreakoutState, key: string): BreakoutRoom | null {
  if (!breakout.active || !key) return null;
  return breakout.rooms.find((room) => room.members.includes(key)) ?? null;
}

/**
 * The people the local participant shares a room with. `participants` lists
 * the local peer first (the convention across this package); it always stays.
 */
export function filterBreakoutParticipants<
  T extends { id?: string; userId?: string; customParticipantId?: string },
>(breakout: BreakoutState, participants: T[]): T[] {
  if (!breakout.active || participants.length <= 1) return participants;
  const ownRoomId = breakoutRoomOf(breakout, participantKey(participants[0]))?.id ?? null;
  return participants.filter(
    (p, index) => index === 0 || (breakoutRoomOf(breakout, participantKey(p))?.id ?? null) === ownRoomId,
  );
}

// ─── Wire formats ────────────────────────────────────────────────────────────

interface TimerWire {
  status: TimerStatus;
  rev: number;
  by: string;
  durationMs: number;
  remainingMs: number;
}

interface QuestionWire {
  id: string;
  text: string;
  authorKey: string;
  authorName: string;
  askedAt: number;
  rev: number;
  answered: boolean;
  deleted: boolean;
}

interface VoteWire {
  id: string;
  voter: string;
  on: boolean;
  rev: number;
}

interface BreakoutWire {
  active: boolean;
  rev: number;
  by: string;
  rooms: BreakoutRoom[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTimerWire(data: unknown): TimerWire | null {
  if (!isRecord(data)) return null;
  const { status } = data;
  const rev = num(data.rev);
  const by = str(data.by, MAX_NAME_LENGTH);
  const durationMs = num(data.durationMs);
  const remainingMs = num(data.remainingMs);
  if (status !== 'idle' && status !== 'running' && status !== 'paused') return null;
  if (rev === null || by === null || durationMs === null || remainingMs === null) return null;
  return {
    status,
    rev,
    by,
    durationMs: clampMs(durationMs),
    remainingMs: clampMs(remainingMs),
  };
}

function readQuestionWire(data: unknown): QuestionWire | null {
  if (!isRecord(data)) return null;
  const id = str(data.id, 64);
  const text = str(data.text, MAX_QUESTION_LENGTH);
  const authorKey = str(data.authorKey, MAX_NAME_LENGTH);
  const authorName = str(data.authorName, MAX_NAME_LENGTH);
  const askedAt = num(data.askedAt);
  const rev = num(data.rev);
  if (!id || text === null || authorKey === null || authorName === null || askedAt === null || rev === null) {
    return null;
  }
  return { id, text, authorKey, authorName, askedAt, rev, answered: data.answered === true, deleted: data.deleted === true };
}

function readVoteWire(data: unknown): VoteWire | null {
  if (!isRecord(data)) return null;
  const id = str(data.id, 64);
  const voter = str(data.voter, MAX_NAME_LENGTH);
  const rev = num(data.rev);
  if (!id || !voter || rev === null) return null;
  return { id, voter, on: data.on === true, rev };
}

function readBreakoutWire(data: unknown): BreakoutWire | null {
  if (!isRecord(data) || !Array.isArray(data.rooms)) return null;
  const rev = num(data.rev);
  const by = str(data.by, MAX_NAME_LENGTH);
  if (rev === null || by === null) return null;
  const rooms: BreakoutRoom[] = [];
  for (const raw of data.rooms.slice(0, MAX_ROOMS)) {
    if (!isRecord(raw) || !Array.isArray(raw.members)) continue;
    const id = str(raw.id, 64);
    const name = str(raw.name, MAX_NAME_LENGTH);
    if (!id || name === null) continue;
    const members = raw.members
      .filter((m): m is string => typeof m === 'string' && m.length > 0)
      .slice(0, MAX_ROOM_MEMBERS);
    rooms.push({ id, name, members });
  }
  return { active: data.active === true, rev, by, rooms };
}

function clampMs(ms: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, Math.round(ms)));
}

/** A change wins when its revision is higher; equal revisions break on the author. */
function wins(rev: number, by: string, currentRev: number, currentBy: string): boolean {
  return rev > currentRev || (rev === currentRev && by > currentBy);
}

function toQuestionWire(q: QaQuestion): QuestionWire {
  return {
    id: q.id,
    text: q.text,
    authorKey: q.authorKey,
    authorName: q.authorName,
    askedAt: q.askedAt,
    rev: q.rev,
    answered: q.answered,
    deleted: q.deleted,
  };
}

/** A small random delay so everyone holding state does not answer a snapshot request at once. */
function jitterMs(max: number): number {
  const bytes = new Uint16Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return bytes[0]! % max;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface BroadcastMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

export class MeetingToolsStore {
  private state: MeetingToolsState = createInitialToolsState();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: MeetingToolsEvent) => void>();
  private timerTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingSyncReplies = new Map<string, ReturnType<typeof setTimeout>>();
  private receivedSync = false;

  constructor(private readonly meeting: MeetingClient) {
    try {
      meeting.participants?.on?.('broadcastedMessage', this.handleBroadcast);
    } catch {
      // Without the channel the tools still work locally for this viewer.
    }
    try {
      // Whatever was broadcast while this client was disconnected never
      // arrived (a stopped timer, rooms that were closed), and what it changed
      // itself never left. Catch up, and say again where things stand here.
      meeting.self?.on?.('roomJoined', (payload?: { reconnected?: boolean }) => {
        if (!payload?.reconnected) return;
        setTimeout(() => {
          this.requestSync();
          this.announceState();
        }, 400);
      });
    } catch {
      // Older SDKs without the event: state then only heals on the next change.
    }
    // Ask whoever is already in the room for the current state. Asked twice:
    // the first request can go out before the room socket is ready to relay.
    setTimeout(() => this.requestSync(), 400);
    setTimeout(() => {
      if (!this.receivedSync) this.requestSync();
    }, 4000);
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  getState = (): MeetingToolsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent = (listener: (event: MeetingToolsEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  get selfKey(): string {
    return participantKey(this.meeting.self);
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  startTimer(durationMs: number): void {
    const ms = clampMs(durationMs);
    if (ms <= 0) return;
    this.commitTimer({ status: 'running', durationMs: ms, remainingMs: ms });
  }

  pauseTimer(): void {
    const { timer } = this.state;
    if (timer.status !== 'running') return;
    this.commitTimer({ status: 'paused', durationMs: timer.durationMs, remainingMs: timerRemainingMs(timer) });
  }

  resumeTimer(): void {
    const { timer } = this.state;
    if (timer.status !== 'paused') return;
    this.commitTimer({ status: 'running', durationMs: timer.durationMs, remainingMs: timer.remainingMs });
  }

  addTimerTime(ms: number): void {
    const { timer } = this.state;
    if (timer.status === 'idle') return;
    this.commitTimer({
      status: timer.status,
      durationMs: clampMs(timer.durationMs + ms),
      remainingMs: clampMs(timerRemainingMs(timer) + ms),
    });
  }

  stopTimer(): void {
    if (this.state.timer.status === 'idle') return;
    this.commitTimer({ status: 'idle', durationMs: 0, remainingMs: 0 });
  }

  // ── Q&A ───────────────────────────────────────────────────────────────────

  askQuestion(text: string): void {
    const trimmed = text.trim().slice(0, MAX_QUESTION_LENGTH);
    if (!trimmed) return;
    const wire: QuestionWire = {
      id: `q_${Date.now().toString(36)}${randomIdSuffix(6)}`,
      text: trimmed,
      authorKey: this.selfKey,
      authorName: (this.meeting.self?.name || 'Guest').slice(0, MAX_NAME_LENGTH),
      askedAt: Date.now(),
      rev: 1,
      answered: false,
      deleted: false,
    };
    this.applyQuestion(wire, true);
    this.send(MSG.question, wire);
  }

  setQuestionAnswered(id: string, answered: boolean): void {
    const question = this.state.questions.find((q) => q.id === id);
    if (!question || question.deleted) return;
    const wire = { ...toQuestionWire(question), rev: question.rev + 1, answered };
    this.applyQuestion(wire, true);
    this.send(MSG.question, wire);
  }

  removeQuestion(id: string): void {
    const question = this.state.questions.find((q) => q.id === id);
    if (!question || question.deleted) return;
    const wire = { ...toQuestionWire(question), text: '', rev: question.rev + 1, deleted: true };
    this.applyQuestion(wire, true);
    this.send(MSG.question, wire);
  }

  toggleQuestionVote(id: string): void {
    const question = this.state.questions.find((q) => q.id === id);
    const voter = this.selfKey;
    if (!question || question.deleted || !voter) return;
    const current = question.votes[voter];
    const wire: VoteWire = { id, voter, on: !current?.on, rev: (current?.rev ?? 0) + 1 };
    this.applyVote(wire);
    this.send(MSG.vote, wire);
  }

  // ── Breakout rooms ────────────────────────────────────────────────────────

  setBreakout(next: { active: boolean; rooms: BreakoutRoom[] }): void {
    const wire: BreakoutWire = {
      active: next.active,
      rooms: next.rooms.slice(0, MAX_ROOMS),
      rev: this.state.breakout.rev + 1,
      by: this.selfKey,
    };
    this.applyBreakout(wire, true);
    this.send(MSG.breakout, wire);
  }

  /** Move the local participant to a room (`null` = back to the main room). */
  moveSelfToRoom(roomId: string | null): void {
    const self = this.selfKey;
    const { breakout } = this.state;
    if (!self || !breakout.active) return;
    this.setBreakout({
      active: true,
      rooms: breakout.rooms.map((room) => {
        const others = room.members.filter((m) => m !== self);
        return { ...room, members: room.id === roomId ? [...others, self] : others };
      }),
    });
  }

  // ── Local preferences ─────────────────────────────────────────────────────

  setPrefs(patch: Partial<ToolsPrefs>): void {
    this.set({ prefs: { ...this.state.prefs, ...patch } });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private set(patch: Partial<MeetingToolsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private emit(event: MeetingToolsEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private send(type: string, data: unknown): void {
    // RealtimeKit only carries primitives per key, so the body goes as one JSON string.
    Promise.resolve()
      .then(() => this.meeting.participants?.broadcastMessage?.(type, { json: JSON.stringify(data) }))
      .catch((err: unknown) => {
        console.error(`[WeldMeet] broadcast ${type} failed:`, err);
      });
  }

  private commitTimer(next: Pick<TimerWire, 'status' | 'durationMs' | 'remainingMs'>): void {
    const wire: TimerWire = { ...next, rev: this.state.timer.rev + 1, by: this.selfKey };
    this.applyTimer(wire, true);
    this.send(MSG.timer, wire);
  }

  private applyTimer(wire: TimerWire, quiet: boolean): void {
    const current = this.state.timer;
    if (!wins(wire.rev, wire.by, current.rev, current.by)) return;
    const running = wire.status === 'running';
    this.set({
      timer: {
        status: wire.status,
        rev: wire.rev,
        by: wire.by,
        durationMs: wire.durationMs,
        remainingMs: wire.remainingMs,
        endsAt: running ? Date.now() + wire.remainingMs : null,
        endedAt: null,
      },
    });
    this.scheduleTimerEnd();
    if (!quiet && running && current.status === 'idle') {
      this.emit({ type: 'timer-started', durationMs: wire.durationMs });
    }
  }

  /**
   * Every client ends the countdown on its own clock instead of waiting for a
   * message, so the cue still fires when the person who started it has left.
   */
  private scheduleTimerEnd(): void {
    if (this.timerTimeout) clearTimeout(this.timerTimeout);
    this.timerTimeout = null;
    const { timer } = this.state;
    if (timer.status !== 'running' || timer.endsAt === null) return;
    this.timerTimeout = setTimeout(() => {
      this.timerTimeout = null;
      const latest = this.state.timer;
      if (latest.status !== 'running' || latest.endsAt === null) return;
      if (Date.now() < latest.endsAt) {
        this.scheduleTimerEnd();
        return;
      }
      this.set({ timer: { ...latest, status: 'idle', remainingMs: 0, endsAt: null, endedAt: Date.now() } });
      this.emit({ type: 'timer-ended' });
    }, Math.max(0, timer.endsAt - Date.now()));
  }

  private applyQuestion(wire: QuestionWire, quiet: boolean): void {
    const { questions } = this.state;
    const existing = questions.find((q) => q.id === wire.id);
    if (!existing) {
      if (questions.length >= MAX_QUESTIONS) return;
      const question: QaQuestion = { ...wire, votes: {} };
      this.set({ questions: [...questions, question] });
      if (!quiet && !question.deleted && question.authorKey !== this.selfKey) {
        this.emit({ type: 'question-asked', question });
      }
      return;
    }
    // Same revision: a removal beats an answer, an answer beats "open".
    const newer =
      wire.rev > existing.rev ||
      (wire.rev === existing.rev &&
        ((wire.deleted && !existing.deleted) || (wire.answered && !existing.answered)));
    if (!newer) return;
    this.set({
      questions: questions.map((q) =>
        q.id === wire.id
          ? { ...q, rev: wire.rev, answered: wire.answered, deleted: wire.deleted, text: wire.deleted ? '' : q.text }
          : q,
      ),
    });
  }

  private applyVote(wire: VoteWire): void {
    const { questions } = this.state;
    const question = questions.find((q) => q.id === wire.id);
    if (!question) return;
    const current = question.votes[wire.voter];
    if (current && current.rev >= wire.rev) return;
    this.set({
      questions: questions.map((q) =>
        q.id === wire.id ? { ...q, votes: { ...q.votes, [wire.voter]: { on: wire.on, rev: wire.rev } } } : q,
      ),
    });
  }

  private applyBreakout(wire: BreakoutWire, local: boolean): void {
    const current = this.state.breakout;
    if (!wins(wire.rev, wire.by, current.rev, current.by)) return;
    const self = this.selfKey;
    const before = breakoutRoomOf(current, self);
    const next: BreakoutState = { active: wire.active, rev: wire.rev, by: wire.by, rooms: wire.rooms };
    this.set({ breakout: next });
    if (local) return;
    const after = breakoutRoomOf(next, self);
    const closed = current.active && !next.active;
    if (closed || (before?.id ?? null) !== (after?.id ?? null)) {
      this.emit({ type: 'breakout-room-changed', roomName: after?.name ?? null, active: next.active });
    }
  }

  private hasSharedState(): boolean {
    const { timer, questions, breakout } = this.state;
    return timer.rev > 0 || questions.length > 0 || breakout.rev > 0;
  }

  private requestSync(): void {
    const from = this.meeting.self?.id;
    if (from) this.send(MSG.syncRequest, { from });
  }

  private timerWire(): TimerWire {
    const { timer } = this.state;
    const remainingMs = timerRemainingMs(timer);
    // A countdown that already ran out here is over, even if the timeout
    // that ends it has not fired yet (throttled background tab).
    const expired = timer.status === 'running' && remainingMs <= 0;
    return {
      status: expired ? 'idle' : timer.status,
      rev: timer.rev,
      by: timer.by,
      durationMs: timer.durationMs,
      remainingMs,
    };
  }

  private breakoutWire(): BreakoutWire {
    const { breakout } = this.state;
    return { active: breakout.active, rev: breakout.rev, by: breakout.by, rooms: breakout.rooms };
  }

  /** Re-send the timer and the rooms as this client knows them; only newer state is taken over. */
  private announceState(): void {
    if (this.state.timer.rev > 0) this.send(MSG.timer, this.timerWire());
    if (this.state.breakout.rev > 0) this.send(MSG.breakout, this.breakoutWire());
  }

  private scheduleSyncReply(requester: string): void {
    if (!this.hasSharedState() || this.pendingSyncReplies.has(requester)) return;
    const timeout = setTimeout(() => {
      this.pendingSyncReplies.delete(requester);
      this.send(MSG.sync, {
        for: requester,
        timer: this.timerWire(),
        breakout: this.breakoutWire(),
        questions: this.state.questions.map((q) => ({ ...toQuestionWire(q), votes: q.votes })),
      });
    }, 100 + jitterMs(800));
    this.pendingSyncReplies.set(requester, timeout);
  }

  private applySync(data: JsonRecord): void {
    this.receivedSync = true;
    // Somebody answered this request already; no need to answer it again.
    const requester = str(data.for, 128);
    if (requester) {
      const pending = this.pendingSyncReplies.get(requester);
      if (pending) clearTimeout(pending);
      this.pendingSyncReplies.delete(requester);
    }
    const timer = readTimerWire(data.timer);
    if (timer) this.applyTimer(timer, true);
    const breakout = readBreakoutWire(data.breakout);
    if (breakout) this.applyBreakout(breakout, false);
    if (!Array.isArray(data.questions)) return;
    for (const raw of data.questions.slice(0, MAX_QUESTIONS)) {
      const question = readQuestionWire(raw);
      if (!question) continue;
      this.applyQuestion(question, true);
      const votes = isRecord(raw) && isRecord(raw.votes) ? raw.votes : {};
      for (const [voter, vote] of Object.entries(votes)) {
        const wire = readVoteWire({ id: question.id, voter, ...(isRecord(vote) ? vote : {}) });
        if (wire) this.applyVote(wire);
      }
    }
  }

  private readonly handleBroadcast = (message: BroadcastMessage): void => {
    const type = message?.type;
    if (typeof type !== 'string' || !type.startsWith('call:tools:')) return;
    const json = message.payload?.json;
    if (typeof json !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    // RealtimeKit echoes a broadcast back to its sender. Every handler below
    // is idempotent (a change only applies when it is newer), so the echo of
    // a change this client already applied is a no-op.
    switch (type) {
      case MSG.timer: {
        const wire = readTimerWire(data);
        if (wire) this.applyTimer(wire, false);
        break;
      }
      case MSG.question: {
        const wire = readQuestionWire(data);
        if (wire) this.applyQuestion(wire, false);
        break;
      }
      case MSG.vote: {
        const wire = readVoteWire(data);
        if (wire) this.applyVote(wire);
        break;
      }
      case MSG.breakout: {
        const wire = readBreakoutWire(data);
        if (wire) this.applyBreakout(wire, false);
        break;
      }
      case MSG.syncRequest: {
        const from = isRecord(data) ? str(data.from, 128) : null;
        if (from && from !== this.meeting.self?.id) this.scheduleSyncReply(from);
        break;
      }
      case MSG.sync: {
        if (isRecord(data)) this.applySync(data);
        break;
      }
      default:
        break;
    }
  };
}

const stores = new WeakMap<object, MeetingToolsStore>();

/** The tools store of a meeting client, created on first use. */
export function getMeetingToolsStore(meeting: MeetingClient): MeetingToolsStore {
  let store = stores.get(meeting);
  if (!store) {
    store = new MeetingToolsStore(meeting);
    stores.set(meeting, store);
  }
  return store;
}
