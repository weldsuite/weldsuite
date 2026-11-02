/**
 * Cron jobs in conformance mode. A cron test calls the job's function
 * directly (`runLifecycleSweep(env, now)`), not through `request()`, so it
 * wraps that call in `conformanceSweep()`:
 *
 * - outside conformance mode it just runs the TypeScript job;
 * - in it, the job runs on the Rust server first
 *   (`POST /__conformance/cron/<job>`, against the test's tenant and master
 *   pglite), then on TypeScript against a copy of the tenant database taken
 *   before, as a write request does. The result, the entity events, the mail
 *   and the due index must match; the test gets Rust's result and Rust's
 *   mail, and its own database assertions see Rust's writes.
 *
 * The due index lives in a D1 database on Global and in the master table
 * `workspace_due_index` on Kubernetes (keyed by `workspaces.id`, not the
 * Clerk org id), so the two are compared by their due times. A D1 the
 * harness hasn't seen yet is a new, empty index: the master rows of that
 * kind are cleared for Rust too. The job's one-time seed flag lives in the
 * test's KV namespace; each namespace is its own seed scope on the Rust side.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../env';
import { pgliteClientOf } from './pglite';
import {
  cloneDatabase,
  conformanceTarget,
  currentTest,
  databaseUrlFor,
  firstDifference,
  forwardedEnv,
  normalizeForDiff,
  record,
  rustSideEffects,
  type PGliteClient,
} from './conformance';
import { createMailCollector, mailRecord } from './conformance-mail';

/** The part of a D1 binding the comparison reads. */
interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> };
  };
}

export interface ConformanceSweep<R> {
  /** The job as the Rust server names it: `/__conformance/cron/<job>`. */
  job: 'sign-lifecycle' | 'calendar-replan';
  now: Date;
  tenantDb: Database;
  masterDb: Database;
  /** The job's env (the forwarded values go to Rust). */
  env: Record<string, unknown>;
  /** The test's due index and the kind the job keeps in it. */
  dueIndex: { d1: D1Like; kind: string };
  /** The test's KV namespace, where the job keeps its seed flag. */
  kv: object;
  /**
   * The test set the job's seed flag in `kv` itself (not by an earlier tick):
   * Rust's seed scope starts with it set too.
   */
  seeded?: boolean;
  /** `workspaces.id` → Clerk org id, as the test's `getWorkspaceForOrg` mock answers. */
  workspaces: Record<string, string>;
  /** Run the job on TypeScript with `tenantDb` as the tenant database. */
  runTypeScript: (tenantDb: Database) => Promise<R>;
  /** The entity events TypeScript published since the last call (`publishEntityEventRaw` inputs). */
  takeTypeScriptEvents: () => Array<Record<string, unknown>>;
  /** Hands the test Rust's events in place of TypeScript's. */
  onRustEvents?: (events: Array<Record<string, unknown>>) => void;
}

const seenIndexes = new WeakSet<object>();
const seedScopes = new WeakMap<object, string>();
const mail = createMailCollector();

function seedScope(kv: object): string {
  let scope = seedScopes.get(kv);
  if (!scope) {
    scope = `kv-${randomUUID()}`;
    seedScopes.set(kv, scope);
  }
  return scope;
}

function clientOf(db: Database, what: string): PGliteClient {
  const client = pgliteClientOf(db);
  if (!client) throw new Error(`Conformance cron: the ${what} database must be pglite`);
  return client;
}

/**
 * What both runtimes publish, in the fields both carry: TypeScript's
 * `publishEntityEventRaw` input has the ids at the top, the hub message Rust
 * records has them in `metadata`.
 */
function eventShape(event: Record<string, unknown>) {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  return {
    workspaceId: event.workspaceId ?? metadata.workspaceId,
    userId: event.userId ?? metadata.userId,
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: event.data,
  };
}

async function dueTimes(opts: ConformanceSweep<unknown>, master: PGliteClient) {
  const d1 = await opts.dueIndex.d1
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ?')
    .bind(opts.dueIndex.kind)
    .all<{ next_due_at: number }>();
  const rows = (await master.query(
    'select (extract(epoch from next_due_at) * 1000)::float8 as at from workspace_due_index where kind = $1',
    [opts.dueIndex.kind],
  )) as { rows: Array<{ at: number }> };
  return {
    typescript: d1.results.map((r) => Number(r.next_due_at)).sort((a, b) => a - b),
    rust: rows.rows.map((r) => Math.round(Number(r.at))).sort((a, b) => a - b),
  };
}

/** Run a cron job on both runtimes and compare; returns Rust's result. */
export async function conformanceSweep<R extends object>(opts: ConformanceSweep<R>): Promise<R> {
  const target = conformanceTarget();
  if (!target) return opts.runTypeScript(opts.tenantDb);

  const tenant = clientOf(opts.tenantDb, 'tenant');
  const master = clientOf(opts.masterDb, 'master');
  if (!seenIndexes.has(opts.dueIndex.d1)) {
    seenIndexes.add(opts.dueIndex.d1);
    await master.query('delete from workspace_due_index where kind = $1', [opts.dueIndex.kind]);
  }
  // Start every recording empty.
  mail.take();
  opts.takeTypeScriptEvents();
  await rustSideEffects(target);

  const clone = await cloneDatabase(tenant);
  let rust: R;
  let typescript: R;
  let rustSide: Awaited<ReturnType<typeof rustSideEffects>>;
  let tsMail: ReturnType<typeof mail.take>;
  let tsEvents: Array<Record<string, unknown>>;
  try {
    const response = await fetch(`${target.url}/__conformance/cron/${opts.job}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        now: opts.now.toISOString(),
        databaseUrl: await databaseUrlFor(tenant),
        masterDatabaseUrl: await databaseUrlFor(master),
        env: forwardedEnv(opts.env),
        workspaces: opts.workspaces,
        seedScope: seedScope(opts.kv),
        seeded: opts.seeded ?? false,
      }),
    });
    if (!response.ok) throw new Error(`Conformance cron: ${opts.job} answered ${response.status}: ${await response.text()}`);
    rust = (await response.json()) as R;
    rustSide = await rustSideEffects(target);
    typescript = await opts.runTypeScript(clone.db);
    tsMail = mail.take();
    tsEvents = opts.takeTypeScriptEvents();
  } finally {
    await clone.close();
  }

  const picked = Object.fromEntries(Object.keys(rust).map((k) => [k, (typescript as Record<string, unknown>)[k]]));
  const due = await dueTimes(opts as ConformanceSweep<unknown>, master);
  const difference =
    firstDifference(picked, rust, '$result') ??
    firstDifference(
      normalizeForDiff(tsEvents.map(eventShape), true),
      normalizeForDiff((rustSide.effects.events as Array<Record<string, unknown>>).map(eventShape), true),
      '$events',
    ) ??
    firstDifference(
      tsMail.map((m) => mailRecord(m.email)),
      rustSide.effects.mail,
      '$mail',
    ) ??
    firstDifference(due.typescript, due.rust, '$dueIndex');

  // The test reads Rust's mail and events, as it reads Rust's result.
  mail.adopt(tsMail, rustSide.mail);
  opts.onRustEvents?.((rustSide.effects.events as Array<Record<string, unknown>>).map(eventShape));

  if (target.reportDir) {
    const { file, test } = await currentTest();
    await record(target.reportDir, {
      file,
      test,
      method: 'CRON',
      path: opts.job,
      route: opts.job,
      tsStatus: 200,
      rustStatus: 200,
      match: difference === null,
      difference,
      schema: 'none',
      schemaError: null,
    });
  }
  if (target.strict && difference) {
    throw new Error(`Conformance: cron ${opts.job} differs between TypeScript and Rust: ${difference}`);
  }
  return rust;
}
