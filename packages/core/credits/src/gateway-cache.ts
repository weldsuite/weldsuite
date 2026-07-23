/**
 * Gateway credit snapshot cache — how the router answers "is this gateway free?"
 * in a Cloudflare Worker without touching the master DB.
 *
 * Shape: the rollup cron (workflow-worker, the only worker with one) publishes a
 * ~200-byte blob to `WORKSPACE_CACHE`; every AI call reads it. That KV namespace
 * is bound in BOTH workers with identical ids per environment, so one publishes
 * what the other reads. 1 write/min to 1 key is 60× under KV's per-key limit.
 *
 * ## Staleness is bounded and benign
 *
 *   call → next cron tick        ≤ 60s
 *   rollup → KV propagation      ~60s
 *   reader's cacheTtl            60s (overlaps)
 *   ────────────────────────────────
 *   worst case                   ~120s of spend unaccounted
 *
 * Absorbed by `exhaustionMarginNanoUsd` ($0.25 default ⇒ ~$0.125/min of burn,
 * far above a $5/mo allowance's natural rate). Overshoot means paying list price
 * on a handful of calls. The customer's charge is unaffected by construction.
 * This is a **soft budget**; a master round-trip per AI call to harden it is a
 * bad trade.
 *
 * ## Never fall back to the DB
 *
 * On a KV miss the router uses `AI_GATEWAY_ORDER` and moves on. Falling back to
 * a master query would turn a KV outage into a DB stampede at per-call rate —
 * converting a cosmetic degradation into an outage. That is the single most
 * important rule in this file.
 */

import type { Gateway, GatewayCreditRow } from './gateway-costs.js';

/** KV key for the snapshot. Versioned so a shape change can't be misread. */
export const GATEWAY_CREDIT_KV_KEY = 'ai:gw:credit:v1';
/** KV entry TTL. A wedged cron self-limits: the blob simply expires. */
export const GATEWAY_CREDIT_KV_TTL_SECONDS = 120;
/** Edge cacheTtl for reads — after the first hit in a colo this is memory-local. */
export const GATEWAY_CREDIT_KV_CACHE_TTL_SECONDS = 60;
/** Snapshots older than this are ignored, guarding against a wedged cron. */
export const GATEWAY_CREDIT_MAX_AGE_MS = 10 * 60 * 1000;
/** Lock key so an overrunning rollup can't overlap the next tick. */
export const GATEWAY_ROLLUP_LOCK_KEY = 'ai:gw:rollup:inflight';

export interface GatewayCreditSnapshotEntry {
  gateway: Gateway;
  /** `null` = unlimited. `0` = exhausted (margin already applied). */
  remainingNanoUsd: number | null;
  enabled: boolean;
  priority: number;
}

export interface GatewayCreditSnapshot {
  /** Epoch ms the snapshot was built — lets readers reject a stale blob. */
  at: number;
  gateways: GatewayCreditSnapshotEntry[];
}

/** Minimal KV surface we need — keeps this testable without workers-types. */
export interface KvLike {
  get(key: string, options?: { type: 'json'; cacheTtl?: number }): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function toSnapshot(rows: GatewayCreditRow[], now = new Date()): GatewayCreditSnapshot {
  return {
    at: now.getTime(),
    gateways: rows.map((r) => ({
      gateway: r.gateway,
      remainingNanoUsd: r.remainingNanoUsd,
      enabled: r.enabled,
      priority: r.priority,
    })),
  };
}

/** True when the blob is well-formed and fresh enough to route on. */
export function isSnapshotUsable(
  snapshot: unknown,
  now = Date.now(),
  maxAgeMs = GATEWAY_CREDIT_MAX_AGE_MS,
): snapshot is GatewayCreditSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const s = snapshot as Partial<GatewayCreditSnapshot>;
  if (typeof s.at !== 'number' || !Array.isArray(s.gateways)) return false;
  return now - s.at <= maxAgeMs;
}

/**
 * Hot path: one edge-cached KV read. Returns `null` on miss, parse error, stale
 * blob, or KV being down — never throws, and **never** queries the DB.
 * `null` means "no credit info", which degrades routing to fee order, not failure.
 */
export async function readGatewayCreditSnapshot(kv: KvLike): Promise<GatewayCreditSnapshot | null> {
  try {
    const raw = await kv.get(GATEWAY_CREDIT_KV_KEY, {
      type: 'json',
      cacheTtl: GATEWAY_CREDIT_KV_CACHE_TTL_SECONDS,
    });
    return isSnapshotUsable(raw) ? raw : null;
  } catch (err) {
    console.warn('[credits/gateway-cache] snapshot read failed — routing on fee order:', err);
    return null;
  }
}

/** Cron only. Publish the snapshot the whole platform routes on. */
export async function writeGatewayCreditSnapshot(
  kv: KvLike,
  snapshot: GatewayCreditSnapshot,
): Promise<void> {
  await kv.put(GATEWAY_CREDIT_KV_KEY, JSON.stringify(snapshot), {
    expirationTtl: GATEWAY_CREDIT_KV_TTL_SECONDS,
  });
}

/** Snapshot entries → the shape `@weldsuite/ai`'s router expects. */
export function toCreditStates(snapshot: GatewayCreditSnapshot | null): GatewayCreditSnapshotEntry[] {
  return snapshot?.gateways ?? [];
}
