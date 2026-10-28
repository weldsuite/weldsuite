/**
 * Where an API request's time went: KV, the master DB, permission lookups and
 * the tenant database.
 *
 * `requestTiming()` (global middleware in `createModuleApi`) gives every
 * request a `RequestTiming` on `c.get('timing')`. Tenant resolution records its
 * KV read and master lookup, the tenant DB client records each Neon HTTP call,
 * and the permission lookups record themselves. When the response is ready the
 * totals go out twice:
 *
 * - a `Server-Timing` header, which DevTools shows per request and which the
 *   platform reads back through Resource Timing (`Timing-Allow-Origin` is set
 *   for first-party origins only);
 * - one structured log line per request that reached a workspace, which
 *   Workers Logs can filter and aggregate (`message: "request timing"`).
 *
 * Durations are waits on I/O. Workers only advance the clock across I/O, so
 * CPU work inside a request reads as 0 ms; that is fine here, the question is
 * how long a request waited on KV, Postgres and the network.
 *
 * `db` is the sum of every tenant query's duration, so overlapping queries can
 * add up to more than the request took. Permission lookups are tenant queries
 * too: they count in both `perm` and `db`.
 *
 * The first tenant query is also reported on its own (`db-first`). On a Neon
 * compute that had suspended it carries the wake-up, so a slow `db-first` marks
 * a probable cold start (`coldStart` in the log line).
 *
 * docs/plans/weldmail-mailbox-storage.md, phase 0.
 */

import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { PermissionDbQuery } from '@weldsuite/permissions/server';
import { resolveCorsOrigin } from './cors';

export type TimingMetric = 'kv' | 'master' | 'perm' | 'db';

/** A first tenant query at least this slow is logged as a probable compute wake-up. */
export const COLD_START_THRESHOLD_MS = 300;

/** Server-Timing order; `db-first` and `total` are derived. */
const METRICS: readonly TimingMetric[] = ['kv', 'master', 'perm', 'db'];

export interface TimingSummary {
  totalMs: number;
  kvMs?: number;
  /** Whether the tenant resolution was served from KV. */
  workspaceCache?: 'hit' | 'miss';
  masterMs?: number;
  permMs?: number;
  permQueries?: number;
  /** Whether the resolved-permissions KV cache served this request (./permission-cache.ts, worker-kit). */
  permCache?: 'hit' | 'miss';
  dbMs?: number;
  dbQueries?: number;
  dbFirstMs?: number;
  coldStart: boolean;
}

export class RequestTiming {
  private readonly startedAt: number;
  private readonly totals = new Map<TimingMetric, { ms: number; count: number }>();
  private firstDbMs: number | null = null;
  private workspaceCache: 'hit' | 'miss' | null = null;
  private permCache: 'hit' | 'miss' | null = null;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  record(metric: TimingMetric, ms: number): void {
    const total = this.totals.get(metric) ?? { ms: 0, count: 0 };
    total.ms += ms;
    total.count += 1;
    this.totals.set(metric, total);
    if (metric === 'db' && this.firstDbMs === null) this.firstDbMs = ms;
  }

  /** Run `work` and record how long it took, whether it resolved or threw. */
  async measure<T>(metric: TimingMetric, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await work();
    } finally {
      this.record(metric, Date.now() - start);
    }
  }

  noteWorkspaceCache(result: 'hit' | 'miss'): void {
    this.workspaceCache = result;
  }

  /** Whether the resolved-permissions KV cache served this request (worker-kit's resolveEffectivePermissionsCached). */
  notePermissionsCache(result: 'hit' | 'miss'): void {
    this.permCache = result;
  }

  /** True once the request has read KV or a database, i.e. it reached a workspace. */
  get touchedStorage(): boolean {
    return this.totals.size > 0;
  }

  summary(now: number = Date.now()): TimingSummary {
    const kv = this.totals.get('kv');
    const master = this.totals.get('master');
    const perm = this.totals.get('perm');
    const db = this.totals.get('db');
    return {
      totalMs: now - this.startedAt,
      ...(kv && { kvMs: kv.ms }),
      ...(this.workspaceCache && { workspaceCache: this.workspaceCache }),
      ...(master && { masterMs: master.ms }),
      ...(perm && { permMs: perm.ms, permQueries: perm.count }),
      ...(this.permCache && { permCache: this.permCache }),
      ...(db && { dbMs: db.ms, dbQueries: db.count }),
      ...(this.firstDbMs !== null && { dbFirstMs: this.firstDbMs }),
      coldStart: this.firstDbMs !== null && this.firstDbMs >= COLD_START_THRESHOLD_MS,
    };
  }

  /** `kv;dur=3;desc="hit", db;dur=120;desc="6 queries", db-first;dur=80, total;dur=210` */
  serverTimingHeader(now: number = Date.now()): string {
    const parts: string[] = [];
    for (const metric of METRICS) {
      const total = this.totals.get(metric);
      if (!total) continue;
      parts.push(
        `${metric};dur=${total.ms};desc="${metricDescription(metric, total.count, this.workspaceCache, this.permCache)}"`,
      );
    }
    if (this.firstDbMs !== null) parts.push(`db-first;dur=${this.firstDbMs}`);
    parts.push(`total;dur=${now - this.startedAt}`);
    return parts.join(', ');
  }
}

function metricDescription(
  metric: TimingMetric,
  count: number,
  wsCache: 'hit' | 'miss' | null,
  permCache: 'hit' | 'miss' | null,
): string {
  if (metric === 'kv' && wsCache) return wsCache;
  if (metric === 'perm' && permCache === 'hit') return 'cached';
  return count === 1 ? '1 query' : `${count} queries`;
}

/**
 * The part of a Neon `NeonQueryPromise` this module relies on: the function it
 * calls when awaited. `neon(url).transaction([...])` reads only `queryData`
 * and `opts` from the queries it is given, so replacing `execute` times a query
 * that is awaited on its own without changing one sent in a batch.
 */
type NeonPendingQuery = { execute?: (...args: unknown[]) => Promise<unknown> };

type NeonClientLike = {
  query: (...args: never[]) => unknown;
  transaction: (...args: never[]) => Promise<unknown>;
};

/**
 * Record every HTTP call a Neon client makes as `db`: each awaited query, and
 * each batch (`db.batch()` → `transaction()`) as one call. Mutates the client
 * in place, so call it on a fresh `neon(url)` before handing it to Drizzle
 * (which reads `client.query` once, when the session is built). If a driver
 * release stops exposing `execute`, queries simply go untimed.
 */
export function instrumentNeonClient<T extends NeonClientLike>(client: T, timing: RequestTiming): T {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  const transaction = client.transaction.bind(client) as (...args: unknown[]) => Promise<unknown>;

  const timedQuery = (...args: unknown[]): unknown => {
    const pending = query(...args) as NeonPendingQuery;
    const execute = pending?.execute;
    if (typeof execute === 'function') {
      pending.execute = (...executeArgs: unknown[]) =>
        timing.measure('db', () => execute.apply(pending, executeArgs));
    }
    return pending;
  };
  const timedTransaction = (...args: unknown[]): Promise<unknown> =>
    timing.measure('db', () => transaction(...args));

  Object.assign(client, { query: timedQuery, transaction: timedTransaction });
  return client;
}

/** Permission lookups that record themselves as `perm`. */
export function timePermissionQueries(
  queries: PermissionDbQuery,
  timing: RequestTiming | undefined,
): PermissionDbQuery {
  if (!timing) return queries;
  return {
    ...queries,
    getMember: (userId) => timing.measure('perm', () => queries.getMember(userId)),
    getRolePermissions: (roleId) => timing.measure('perm', () => queries.getRolePermissions(roleId)),
    getTeamPermissions: (memberId) => timing.measure('perm', () => queries.getTeamPermissions(memberId)),
  };
}

type TimingVariables = {
  timing: RequestTiming;
  requestId: string;
  workspaceId: string;
};

/**
 * Start a `RequestTiming` for the request; on the way out, add the
 * `Server-Timing` header and log the summary of any request that reached a
 * workspace. A WebSocket upgrade (101) is left alone: re-wrapping its response
 * to add a header would drop the socket.
 */
export const requestTiming = (service: string) =>
  createMiddleware<{ Variables: TimingVariables }>(async (c, next) => {
    const timing = new RequestTiming();
    c.set('timing', timing);
    await next();

    if (c.res.status === 101) return;
    const now = Date.now();
    c.header('Server-Timing', timing.serverTimingHeader(now), { append: true });
    const origin = resolveCorsOrigin(c.req.header('Origin'));
    if (origin) c.header('Timing-Allow-Origin', origin);

    if (!timing.touchedStorage) return;
    console.info({
      message: 'request timing',
      service,
      requestId: c.get('requestId'),
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      workspaceId: c.get('workspaceId'),
      ...timing.summary(now),
    });
  });
