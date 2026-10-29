/**
 * `MailStoreMode` primitives (design §2.2, §0 decision 8): parsing an
 * arbitrary value into the type, resolving it for a workspace from Flagship,
 * and the small boolean/ordering helpers every store, router and guard needs
 * instead of re-deriving the same `mode === 'object' || mode === 'object-only'`
 * checks inline.
 *
 * `resolveMailStoreMode` is the low-level evaluator this module owns; the
 * full factory `readMailboxStoreMode` the design sketches in `store/types.ts`
 * (env plus the KV directory plus the router) is a later task's job and is
 * expected to build on top of this, not duplicate it.
 */

import { MAILBOX_STORE_FLAG, type MailStoreMode } from './types';

const MAIL_STORE_MODES: readonly MailStoreMode[] = ['postgres', 'shadow', 'object', 'object-only'];

/**
 * Parse any value (a Flagship string value, JSON from KV, user input) into a
 * `MailStoreMode`. Anything that isn't one of the four known values —
 * `undefined`, `null`, a typo, a future value an older isolate doesn't know
 * about yet — resolves to `'postgres'`, the safe no-behaviour-change default.
 */
export function parseMailStoreMode(value: unknown): MailStoreMode {
  return typeof value === 'string' && (MAIL_STORE_MODES as readonly string[]).includes(value)
    ? (value as MailStoreMode)
    : 'postgres';
}

/** `object` and `object-only` read the mailbox Durable Object; `postgres` and `shadow` read Postgres. */
export function readsFromObject(mode: MailStoreMode): boolean {
  return mode === 'object' || mode === 'object-only';
}

/** Every mode except `object-only` keeps writing Postgres (as the primary, or as the dual-write secondary). */
export function writesPostgres(mode: MailStoreMode): boolean {
  return mode !== 'object-only';
}

/** Every mode except `postgres` writes the mailbox object (as the dual-write secondary, or as the primary). */
export function writesObject(mode: MailStoreMode): boolean {
  return mode !== 'postgres';
}

/** Ascending: further along the migration = less reliant on Postgres being the source of truth. */
const MODE_RANK: Record<MailStoreMode, number> = {
  postgres: 0,
  shadow: 1,
  object: 2,
  'object-only': 3,
};

/**
 * True when `next` relies on Postgres less than `prev` did — the case the
 * design's §2.2 router logs a warning for and that needs a `reverseSync`
 * (design §4) run first, since the object may hold writes Postgres never saw.
 */
export function isDowngrade(prev: MailStoreMode, next: MailStoreMode): boolean {
  return MODE_RANK[next] < MODE_RANK[prev];
}

/**
 * Structural Flagship binding (mirrors `outbound/policy-store.ts`'s identical
 * local type): this module avoids a hard dependency on
 * `@weldsuite/feature-flags` for the same reason that file does — it only
 * needs this one method, and every caller (workers, Durable Objects,
 * workflows) already has a binding that satisfies it structurally.
 */
interface FlagshipLike {
  getStringValue(key: string, defaultValue: string, context?: Record<string, unknown>): Promise<string>;
}

/**
 * The minimal env `resolveMailStoreMode` needs. Works identically whether
 * it's read off a Worker's `c.env` inside a request, or passed directly
 * outside one — a Durable Object, a Workflow step, or a queue consumer never
 * sees a Hono context at all, and a request handler's `c.env` already has
 * this exact shape, so there is no second "request flag context" type to
 * juggle: one function, one env shape, both call sites.
 */
export interface MailStoreModeEnv {
  FLAGSHIP?: FlagshipLike;
  ENVIRONMENT?: string;
}

export interface ResolveMailStoreModeOptions {
  /** Flagship context `app` attribute (design §2.2's `{workspaceId, environment, app}`). Defaults to `'mail-api'`. */
  app?: string;
  /** Test-only: override the clock the isolate cache checks against. */
  now?: () => number;
}

/**
 * 30s: long enough that a burst of reads for one workspace on a warm isolate
 * costs a single Flagship evaluation, short enough that flipping the flag is
 * picked up well within the backfill/catch-up windows that already tolerate
 * mixed modes across isolates during a flip (design §2.2: "both stores still
 * receive every write in the overlapping modes").
 */
const MODE_CACHE_TTL_MS = 30_000;
/**
 * How long past its TTL an entry is kept to answer for a Flagship that
 * doesn't (see `resolveMailStoreMode`). Long enough to ride out an outage;
 * the entry is replaced the moment Flagship answers again.
 */
const MODE_CACHE_STALE_MS = 6 * 60 * 60 * 1000;
/** Upper bound on distinct workspaces remembered per isolate — a small, cheap map. */
const MODE_CACHE_MAX_ENTRIES = 1_000;
/**
 * The default handed to Flagship. The binding returns the default on a miss
 * or an evaluation error instead of throwing, and no variation of the flag
 * has this value, so getting it back means Flagship gave no answer — which
 * a default of `'postgres'` would make indistinguishable from a real one.
 */
const UNRESOLVED = '__unresolved__';

interface ModeCacheEntry {
  mode: MailStoreMode;
  expiresAt: number;
}

const modeCache = new Map<string, ModeCacheEntry>();

/** Drop entries past their stale window, then (rare) the oldest ones until back under the cap. */
function pruneModeCache(now: number): void {
  for (const [workspaceId, entry] of modeCache) {
    if (entry.expiresAt + MODE_CACHE_STALE_MS <= now) modeCache.delete(workspaceId);
  }
  while (modeCache.size > MODE_CACHE_MAX_ENTRIES) {
    const oldest = modeCache.keys().next().value;
    if (oldest === undefined) break;
    modeCache.delete(oldest);
  }
}

/** The workspace's mode per Flagship, or `null` when Flagship gave no answer (a miss or an error). */
async function evaluateMailStoreMode(
  flagship: FlagshipLike,
  env: MailStoreModeEnv,
  workspaceId: string,
  app: string,
): Promise<MailStoreMode | null> {
  try {
    const value = await flagship.getStringValue(MAILBOX_STORE_FLAG, UNRESOLVED, {
      workspaceId,
      environment: env.ENVIRONMENT ?? 'production',
      app,
    });
    if (value === UNRESOLVED) {
      console.error(`[mail-store] Flagship returned no value for ${MAILBOX_STORE_FLAG} (workspace ${workspaceId})`);
      return null;
    }
    return parseMailStoreMode(value);
  } catch (err) {
    console.error('[mail-store] Flagship lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Resolve a workspace's mail-store mode. No `FLAGSHIP` binding (local
 * `wrangler dev`, or a worker the design's §8 binder table hasn't reached
 * yet) resolves to `'postgres'`, matching every other flag's local-dev
 * fallback (`@weldsuite/feature-flags/server`).
 *
 * When Flagship gives no answer (an error, or a miss), the last mode this
 * isolate saw for the workspace keeps being served, even past its TTL, and
 * Flagship is asked again on the next request: falling back to `'postgres'`
 * there would send an `object-only` workspace's writes to a store nothing
 * reads any more. With no last mode, the answer is `'postgres'` for this
 * request only, never cached. Failing the request instead was ruled out:
 * every workspace starts on `'postgres'`, and inbound mail that fails to
 * store is dropped, not retried, so a Flagship outage would lose mail for
 * all of them to protect the few in object modes.
 *
 * Cached per isolate for `MODE_CACHE_TTL_MS` (see above) so a burst of reads
 * for the same workspace costs one Flagship call. `environment` and `app` are
 * constant for an isolate's whole lifetime (one deployed worker, one
 * environment), so the cache only needs to be keyed by `workspaceId`.
 */
export async function resolveMailStoreMode(
  env: MailStoreModeEnv,
  workspaceId: string,
  options: ResolveMailStoreModeOptions = {},
): Promise<MailStoreMode> {
  const now = options.now ?? Date.now;
  const nowMs = now();

  const cached = modeCache.get(workspaceId);
  if (cached && cached.expiresAt > nowMs) return cached.mode;

  const mode = env.FLAGSHIP
    ? await evaluateMailStoreMode(env.FLAGSHIP, env, workspaceId, options.app ?? 'mail-api')
    : 'postgres';
  if (mode === null) return cached?.mode ?? 'postgres';
  modeCache.set(workspaceId, { mode, expiresAt: nowMs + MODE_CACHE_TTL_MS });
  pruneModeCache(nowMs);
  return mode;
}

/** Test-only: clear the isolate cache so tests don't leak into each other. */
export function __resetMailStoreModeCacheForTests(): void {
  modeCache.clear();
}
