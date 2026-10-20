/**
 * Atomic rate limits for the public portals.
 *
 * The first version kept a counter in KV (get, compare, put). KV is eventually
 * consistent and has no compare-and-set, so N concurrent requests all read the
 * same count and all passed: the cap did nothing against a parallel burst. The
 * counters now live in a Durable Object (commerce-api's `PortalRateLimiter`),
 * one instance per limiter key (`idFromName`), which handles one call at a
 * time, so increment-and-check is a single step.
 *
 * Layout:
 *   - {@link applyRateLimitHit}: the pure fixed-window arithmetic.
 *   - {@link RateLimitCounter}: that arithmetic plus the storage around it. The
 *     Durable Object is a thin wrapper around it, and tests drive it directly.
 *   - {@link consumeRateLimit}: what routes call. It talks to a namespace
 *     binding through the small {@link RateLimitNamespace} interface, so a
 *     test can inject an in-memory namespace.
 *
 * Window: fixed, starting at the first hit and lasting `windowSeconds`. Over
 * any interval of one window length a caller can therefore get up to twice the
 * cap (the end of one window plus the start of the next); that is accepted.
 * Hits that are refused are NOT counted, so a flood does not grow the counter.
 */

/** Window and cap of the per-email limit on requesting a code. */
export const RATE_LIMIT_TTL_SECONDS = 15 * 60;
export const RATE_LIMIT_MAX = 5;
/**
 * Code requests per 15 minutes per workspace, across all addresses. Not per
 * IP: buyers reach the worker through the portal's Next server, so they all
 * share its egress IP and an IP key would put every buyer on one budget.
 */
export const REQUEST_RATE_LIMIT_WORKSPACE_MAX = 200;

export interface RateLimitState {
  /** Hits counted in the current window. */
  count: number;
  /** Epoch ms of the first hit of the current window. */
  windowStart: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Hits counted in the current window, including this one when it was allowed. */
  count: number;
  remaining: number;
  /** Epoch ms at which the current window ends. */
  resetAt: number;
}

function assertLimit(max: number, windowSeconds: number): void {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError('Rate limit max must be a positive integer');
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) {
    throw new RangeError('Rate limit window must be at least one second');
  }
}

/**
 * Count one hit against a window. `prev` is the stored state (null = none or
 * cleaned up). Pure: returns the next state and the verdict.
 */
export function applyRateLimitHit(
  prev: RateLimitState | null,
  now: number,
  max: number,
  windowSeconds: number,
): { state: RateLimitState; verdict: RateLimitVerdict } {
  assertLimit(max, windowSeconds);

  // A window ends at windowStart + windowMs. A clock that steps backwards keeps
  // the window open rather than resetting it.
  const live = prev && now < prev.windowStart + prev.windowMs ? prev : null;
  const state: RateLimitState = live ?? { count: 0, windowStart: now, windowMs: windowSeconds * 1000 };
  const resetAt = state.windowStart + state.windowMs;

  if (state.count >= max) {
    return { state, verdict: { allowed: false, count: state.count, remaining: 0, resetAt } };
  }
  const next: RateLimitState = { ...state, count: state.count + 1 };
  return { state: next, verdict: { allowed: true, count: next.count, remaining: max - next.count, resetAt } };
}

/**
 * Give back one hit counted earlier in the current window (an attempt that
 * turned out to succeed). Never below zero; a finished window has nothing to
 * give back. Pure: returns the next state, or `prev` when nothing changes.
 */
export function applyRateLimitRelease(prev: RateLimitState | null, now: number): RateLimitState | null {
  if (!prev || prev.count === 0 || now >= prev.windowStart + prev.windowMs) return prev;
  return { ...prev, count: prev.count - 1 };
}

/** The persistence a {@link RateLimitCounter} needs (a Durable Object's storage, or memory). */
export interface RateLimitCounterStore {
  load(): Promise<RateLimitState | undefined>;
  save(state: RateLimitState): Promise<void>;
  /** Wake `alarm()` at this epoch ms. Replaces any earlier schedule. */
  setAlarm(at: number): Promise<void>;
  /** Forget everything, so an idle counter costs no storage. */
  clear(): Promise<void>;
}

/**
 * One limiter key's counter. Everything between reading the state and
 * replacing it is synchronous, so even with a store that yields, two
 * overlapping `hit` calls can never read the same count. In a Durable Object
 * the runtime already serialises calls; this keeps the class correct on its own.
 */
export class RateLimitCounter {
  private state: RateLimitState | null = null;

  constructor(
    private readonly store: RateLimitCounterStore,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    this.state = (await this.store.load()) ?? null;
  }

  async hit(max: number, windowSeconds: number): Promise<RateLimitVerdict> {
    const prev = this.state;
    const { state, verdict } = applyRateLimitHit(prev, this.now(), max, windowSeconds);
    if (state === prev) return verdict; // refused: nothing changes

    this.state = state;
    // Both writes are issued in the same tick as the state change, so
    // overlapping hits persist in the order they were counted. One alarm per
    // window wipes the storage once the window is over.
    const writes = [this.store.save(state)];
    if (state.count === 1) writes.push(this.store.setAlarm(state.windowStart + state.windowMs));
    await Promise.all(writes);
    return verdict;
  }

  /** Give back one hit of the current window (see {@link applyRateLimitRelease}). */
  async release(): Promise<void> {
    const prev = this.state;
    const next = applyRateLimitRelease(prev, this.now());
    if (next === prev || !next) return;
    this.state = next;
    await this.store.save(next);
  }

  /** Alarm handler: drop a finished window, or wait for one that is still open. */
  async alarm(): Promise<void> {
    const state = this.state;
    if (state && this.now() < state.windowStart + state.windowMs) {
      await this.store.setAlarm(state.windowStart + state.windowMs);
      return;
    }
    this.state = null;
    await this.store.clear();
  }
}

/** The part of a Durable Object stub the limiter calls. */
export interface RateLimitCounterStub {
  hit(max: number, windowSeconds: number): Promise<RateLimitVerdict>;
  release(): Promise<void>;
}

/** The part of a `DurableObjectNamespace` the limiter uses. */
export interface RateLimitNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RateLimitCounterStub;
}

/** The binding the portal limits need. */
export interface PortalRateLimitEnv {
  PORTAL_RATE_LIMITER?: RateLimitNamespace;
}

/** Durable Object name of one limiter key. Never shared between workspaces. */
export function rateLimitKey(workspaceId: string, key: string): string {
  return `cportal:rl:${workspaceId}:${key.trim().toLowerCase()}`;
}

/**
 * - `allowed`: under the cap, the hit was counted.
 * - `limited`: over the cap.
 * - `unavailable`: the counter could not be reached (binding missing, Durable
 *   Object error). The caller decides what that means; both portal endpoints
 *   that call this refuse (fail closed), see the routes.
 */
export type RateLimitOutcome = 'allowed' | 'limited' | 'unavailable';

/**
 * Count one hit for `key` in this workspace and say whether it is within `max`
 * per `windowSeconds`. Atomic across all isolates and locations.
 */
export async function consumeRateLimit(
  env: PortalRateLimitEnv,
  workspaceId: string,
  key: string,
  max: number = RATE_LIMIT_MAX,
  windowSeconds: number = RATE_LIMIT_TTL_SECONDS,
): Promise<RateLimitOutcome> {
  const namespace = env.PORTAL_RATE_LIMITER;
  if (!namespace) {
    console.error('[commerce-domain/portal-rate-limit] PORTAL_RATE_LIMITER binding is missing');
    return 'unavailable';
  }
  try {
    const stub = namespace.get(namespace.idFromName(rateLimitKey(workspaceId, key)));
    const verdict = await stub.hit(max, windowSeconds);
    return verdict.allowed ? 'allowed' : 'limited';
  } catch (err) {
    console.error('[commerce-domain/portal-rate-limit] counter unreachable:', err);
    return 'unavailable';
  }
}

/**
 * Hand back a hit taken by {@link consumeRateLimit}, for limits that only count
 * failures: the caller reserves a slot atomically up front (so parallel
 * attempts cannot all slip past) and releases it once the attempt succeeded.
 * Best effort: when the counter cannot be reached the slot simply stays
 * counted, which errs on the strict side.
 */
export async function releaseRateLimit(env: PortalRateLimitEnv, workspaceId: string, key: string): Promise<void> {
  const namespace = env.PORTAL_RATE_LIMITER;
  if (!namespace) return;
  try {
    await namespace.get(namespace.idFromName(rateLimitKey(workspaceId, key))).release();
  } catch (err) {
    console.error('[commerce-domain/portal-rate-limit] could not release a slot:', err);
  }
}
