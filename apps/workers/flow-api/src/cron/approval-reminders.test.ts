/**
 * The approval reminder sweep on the due index, end to end:
 * `runApprovalReminders(env, now)` lists the SQLite D1 `workspace_due_index`
 * (kind `approval_due`), opens only the due workspace (tenant and master:
 * pglite), reminds approvers a day before a review is due, tells the requester
 * when it is overdue (a notification and a `flow_approval.overdue` entity
 * event), marks each once, and stores when the workspace is next due, or drops
 * it.
 *
 * In conformance mode (CONFORMANCE_TARGET=rust) each tick also runs on the Rust
 * server (`weldsuite cron flow-approval-due`), through `conformanceSweep`:
 * result, events and due index must match, and the assertions below check Rust's
 * run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';

const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => dbs.tenant, getMasterDb: () => dbs.master };
});
const published = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    // As the hub queue carries it: JSON (dates as ISO text), without the env.
    publishEntityEventRaw: vi.fn(async ({ env: _env, ...event }: Record<string, unknown>) => {
      published.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
    }),
  };
});

import { APPROVAL_DUE_SEED_KEY, runApprovalReminders } from './approval-reminders';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const ORG = 'org_apr_due';
const WORKSPACE = 'ws_apr_due';
const REQUESTER = 'user_due_requester';
const APPROVER = 'user_due_approver';
const SECOND = 'user_due_second';
const HOUR = 3_600_000;
const NOW = new Date('2026-11-04T10:00:00.000Z');

let db: Database;
let master: MasterDatabase;
let close: () => Promise<void>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  await master.insert(masterSchema.workspaces).values({ id: WORKSPACE, name: 'Approval due', slug: 'apr-due', clerkOrgId: ORG } as typeof masterSchema.workspaces.$inferInsert);
  await db.insert(schema.projects).values({ id: 'prj_due', name: 'Launch', projectManagerId: REQUESTER, createdAt: NOW, updatedAt: NOW });
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schema.flowApprovals);
  await db.delete(schema.notifications);
  published.splice(0);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

function makeEnv() {
  return { ENVIRONMENT: 'test', SCHEDULE_INDEX: createSqliteD1(MIGRATION), WORKSPACE_CACHE: createMemoryKv() };
}

const swept = new WeakSet<object>();

/** Mark the workspace due in the test's D1 index and, for Rust, in the master one. */
async function markDue(env: ReturnType<typeof makeEnv>, at: Date) {
  // The harness clears the master index the first time it sees a D1: let that happen before the row goes in.
  if (!swept.has(env.SCHEDULE_INDEX)) {
    swept.add(env.SCHEDULE_INDEX);
    expect(await sweep(env, new Date(0))).toMatchObject({ due: 0, reminded: 0, overdue: 0 });
  }
  await markWorkspaceDue(env.SCHEDULE_INDEX as never, 'approval_due', ORG, at);
  if (conformanceTarget()) {
    await master.execute(sql`
      insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
      values ('approval_due', ${WORKSPACE}, ${at.toISOString()}::timestamptz, now(), 1)
      on conflict (kind, workspace_id) do update set
        next_due_at = least(workspace_due_index.next_due_at, excluded.next_due_at)`);
  }
}

/** The due index's time for the workspace, in ms; null when it has no row. */
async function nextDue(env: ReturnType<typeof makeEnv>): Promise<number | null> {
  const { results } = await (env.SCHEDULE_INDEX as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('approval_due', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

/** `runApprovalReminders(env, now)`, on both backends in conformance mode. */
function sweep(env: ReturnType<typeof makeEnv>, now: Date) {
  return conformanceSweep({
    job: 'flow-approval-due',
    now,
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: env as unknown as Record<string, unknown>,
    dueIndex: { d1: env.SCHEDULE_INDEX as never, kind: 'approval_due' },
    kv: env.WORKSPACE_CACHE as object,
    seeded: env.WORKSPACE_CACHE.store.has(APPROVAL_DUE_SEED_KEY),
    workspaces: { [WORKSPACE]: ORG },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        return await runApprovalReminders(env as never, now);
      } finally {
        dbs.tenant = db;
      }
    },
    takeTypeScriptEvents: () => published.splice(0),
    // The assertions on `published` then check Rust's events.
    onRustEvents: (events) => void published.push(...events),
  });
}

async function addReview(id: string, fields: Partial<typeof schema.flowApprovals.$inferInsert> = {}) {
  await db.insert(schema.flowApprovals).values({
    id,
    projectId: 'prj_due',
    subjectType: 'project_close',
    subjectId: 'prj_due',
    approverId: APPROVER,
    rule: { code: 'close' },
    createdBy: REQUESTER,
    createdAt: new Date('2026-11-03T08:00:00.000Z'),
    updatedAt: new Date('2026-11-03T08:00:00.000Z'),
    ...fields,
  });
}

const notices = () =>
  db
    .select()
    .from(schema.notifications)
    .then((rows) => rows.map((n) => [n.userId, n.title, n.actionUrl]).sort());
const review = (id: string) => db.select().from(schema.flowApprovals).where(eq(schema.flowApprovals.id, id)).then((rows) => rows[0]);

describe('approval reminders on the due index', () => {
  it('reminds the approver a day before the review is due, once, and keeps the workspace due for the overdue notice', async () => {
    const env = makeEnv();
    const due = new Date(NOW.getTime() + 20 * HOUR);
    await addReview('apr_due_1', { dueAt: due });
    await markDue(env, new Date(due.getTime() - 24 * HOUR));

    const first = await sweep(env, NOW);
    expect(first).toMatchObject({ due: 1, processed: 1, failed: 0, reminded: 1, overdue: 0 });
    expect(await notices()).toEqual([[APPROVER, 'Review due tomorrow: Launch', '/weldflow/reviews']]);
    expect((await review('apr_due_1'))?.remindedAt).not.toBeNull();
    expect(published).toEqual([]);
    expect(await nextDue(env)).toBe(due.getTime());

    // Nothing is sent again before it is due.
    await markDue(env, NOW);
    expect(await sweep(env, new Date(NOW.getTime() + HOUR))).toMatchObject({ reminded: 0, overdue: 0 });
    expect(await notices()).toHaveLength(1);
  });

  it('tells the requester once the review is overdue, publishes overdue and drops the workspace from the index', async () => {
    const env = makeEnv();
    const due = new Date(NOW.getTime() - 2 * HOUR);
    await addReview('apr_due_2', { dueAt: due });
    await markDue(env, due);

    const result = await sweep(env, NOW);
    expect(result).toMatchObject({ due: 1, processed: 1, reminded: 0, overdue: 1 });
    expect(await notices()).toEqual([[REQUESTER, 'Review overdue: Launch', '/weldflow/reviews']]);
    const row = await review('apr_due_2');
    expect(row?.overdueNotifiedAt).not.toBeNull();
    expect(published).toEqual([
      expect.objectContaining({
        entityType: 'flow_approval',
        action: 'overdue',
        entityId: 'apr_due_2',
        data: expect.objectContaining({ id: 'apr_due_2', subjectType: 'project_close', approverId: APPROVER, decision: 'pending' }),
      }),
    ]);
    expect(await nextDue(env)).toBeNull();
  });

  it('leaves answered reviews, cleared ones, reviews without a due date and reviews waiting for an earlier step alone', async () => {
    const env = makeEnv();
    const due = new Date(NOW.getTime() - HOUR);
    await addReview('apr_due_done', { dueAt: due, decision: 'approved', decidedAt: NOW, decidedBy: APPROVER });
    await addReview('apr_due_gone', { dueAt: due, deletedAt: NOW });
    await addReview('apr_due_none', { dueAt: null });
    // Step 2 waits for step 1, which has not answered: no reminder or notice for it, but it is marked so it is not looked at again.
    await addReview('apr_due_step1', { dueAt: null, approverId: SECOND, step: 1 });
    await addReview('apr_due_step2', { dueAt: due, step: 2 });
    await markDue(env, due);

    const result = await sweep(env, NOW);
    expect(result).toMatchObject({ reminded: 0, overdue: 0 });
    expect(await notices()).toEqual([]);
    expect(published).toEqual([]);
    expect((await review('apr_due_step2'))?.overdueNotifiedAt).not.toBeNull();
    expect((await review('apr_due_done'))?.overdueNotifiedAt).toBeNull();
    expect(await nextDue(env)).toBeNull();
  });

  it('does nothing for a workspace that is not due', async () => {
    const env = makeEnv();
    await addReview('apr_due_far', { dueAt: new Date(NOW.getTime() + 10 * 24 * HOUR) });
    await markDue(env, new Date(NOW.getTime() + 9 * 24 * HOUR));
    expect(await sweep(env, NOW)).toMatchObject({ due: 0, reminded: 0, overdue: 0 });
    expect(await notices()).toEqual([]);
  });
});
