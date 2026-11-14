/**
 * The counter store behind one port (weldsuite-documentation/plans/weldforms.md, "Views and other
 * counters"): views per day, rate-limit windows and wrong-code counts. Never
 * the tenant DB: they are written on every page load and every request. A
 * `FormCounters` Durable Object per form on Global, Valkey on Kubernetes.
 *
 * The rules live in `CounterRules`, on a small storage interface, so the Durable
 * Object and the in-memory test double run the same code. A Durable Object
 * settles one call at a time, which is what makes the lock and the limits
 * atomic; the test double queues its calls the same way.
 */

import { FORM_LIMITS } from '@weldsuite/app-api-client/schemas/weldforms';
import type { FormCounters } from '../durable-objects/form-counters';

export type CodeCheck = { ok: true } | { ok: false; locked: boolean; attemptsLeft: number };

export interface RateCheck {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** What the routes use. */
export interface FormCountersPort {
  /** Count a view; false when this `viewKey` was already counted today (a reload). */
  recordView(day: string, viewKey: string): Promise<boolean>;
  /** Views per UTC day (`YYYY-MM-DD`), `from` and `to` inclusive. */
  viewsByDay(from: string, to: string): Promise<Record<string, number>>;
  /** Count one hit in a fixed window; refused once the window has `limit` hits. */
  rateLimit(scope: string, limit: number, windowSeconds: number): Promise<RateCheck>;
  /** Wrong answers so far for this scope (0 once the window passed). */
  tries(scope: string): Promise<number>;
  /** Settle one answer: refused while locked, clears the count on a match, else counts a miss. */
  attempt(scope: string, match: boolean): Promise<CodeCheck>;
}

/** The storage `CounterRules` needs: Durable Object storage, or a Map in tests. */
export interface CounterStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

interface AttemptState {
  tries: number;
  until: number;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** How long a day's view count is kept (the Rust twin's Valkey TTL). */
const VIEW_DAYS_KEPT = 400;
/** The days that have view markers (`vk:<day>:…`). */
const MARKER_DAYS = 'vk-days';

export class CounterRules implements FormCountersPort {
  constructor(
    private readonly store: CounterStore,
    private readonly now: () => number = Date.now,
  ) {}

  async recordView(day: string, viewKey: string): Promise<boolean> {
    const marker = `vk:${day}:${viewKey}`;
    if (await this.store.get(marker)) return false;
    await this.store.put(marker, 1);
    await this.noteMarkerDay(day);
    const key = `views:${day}`;
    const before = await this.store.get<number>(key);
    await this.store.put(key, (before ?? 0) + 1);
    // A day's count is kept 400 days; the first view of a day drops older ones.
    if (before === undefined) {
      const cutoff = dayOf(this.now() - VIEW_DAYS_KEPT * 86_400_000);
      for (const old of (await this.store.list<number>({ prefix: 'views:' })).keys()) {
        if (old.slice(6) < cutoff) await this.store.delete(old);
      }
    }
    return true;
  }

  /**
   * Markers only dedupe within a day; older ones are dead weight. `vk-days`
   * lists the days that have markers, so a view reads one key here and the
   * first marker of a new day drops the past days' markers, a day's prefix at
   * a time. Without the index (markers written before it) every marker is
   * looked at once.
   */
  private async noteMarkerDay(day: string): Promise<void> {
    const known = await this.store.get<string[]>(MARKER_DAYS);
    if (known?.includes(day)) return;
    const today = dayOf(this.now());
    const days = known ?? [...new Set([...(await this.store.list<number>({ prefix: 'vk:' })).keys()].map((key) => key.slice(3, 13)))];
    const kept = days.filter((d) => d >= today || d === day);
    for (const old of days.filter((d) => !kept.includes(d))) await this.dropMarkers(old);
    await this.store.put(MARKER_DAYS, kept.includes(day) ? kept : [...kept, day]);
  }

  private async dropMarkers(day: string): Promise<void> {
    for (const key of (await this.store.list<number>({ prefix: `vk:${day}:` })).keys()) await this.store.delete(key);
  }

  async viewsByDay(from: string, to: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [key, count] of await this.store.list<number>({ prefix: 'views:' })) {
      const day = key.slice(6);
      if (day >= from && day <= to) out[day] = count;
    }
    return out;
  }

  async rateLimit(scope: string, limit: number, windowSeconds: number): Promise<RateCheck> {
    const now = this.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const key = `rl:${scope}:${window}`;
    const used = (await this.store.get<number>(key)) ?? 0;
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * windowSeconds * 1000 - now) / 1000));
    if (used >= limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    await this.store.put(key, used + 1);
    await this.store.delete(`rl:${scope}:${window - 1}`);
    return { allowed: true, remaining: limit - used - 1, retryAfterSeconds };
  }

  async tries(scope: string): Promise<number> {
    const state = await this.store.get<AttemptState>(`at:${scope}`);
    return state && state.until > this.now() ? state.tries : 0;
  }

  /** Each wrong answer restarts the lock window (15 minutes); five wrong answers lock. */
  async attempt(scope: string, match: boolean): Promise<CodeCheck> {
    const tries = await this.tries(scope);
    if (tries >= FORM_LIMITS.codeMaxAttempts) return { ok: false, locked: true, attemptsLeft: 0 };
    if (match) {
      await this.store.delete(`at:${scope}`);
      return { ok: true };
    }
    const next = tries + 1;
    await this.store.put<AttemptState>(`at:${scope}`, { tries: next, until: this.now() + FORM_LIMITS.codeLockSeconds * 1000 });
    return { ok: false, locked: next >= FORM_LIMITS.codeMaxAttempts, attemptsLeft: Math.max(FORM_LIMITS.codeMaxAttempts - next, 0) };
  }
}

/** One form's counters, through its Durable Object. */
export function countersFor(ns: DurableObjectNamespace<FormCounters>, formId: string): FormCountersPort {
  const stub = ns.get(ns.idFromName(formId));
  return {
    recordView: (day, viewKey) => stub.recordView(day, viewKey),
    viewsByDay: (from, to) => stub.viewsByDay(from, to),
    rateLimit: (scope, limit, windowSeconds) => stub.rateLimit(scope, limit, windowSeconds),
    tries: (scope) => stub.tries(scope),
    attempt: (scope, match) => stub.attempt(scope, match),
  };
}
