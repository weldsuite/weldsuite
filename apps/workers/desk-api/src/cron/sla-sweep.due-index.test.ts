/**
 * The SLA sweep on the due index, end to end: `runSlaSweep(env, now)` lists
 * the SQLite D1 `workspace_due_index` (kind `desk_sla`), opens only the due
 * workspace (tenant and master: pglite), announces the warnings and
 * breaches that came due (timeline event, `desk_conversation` entity event,
 * notification) and stores when the workspace is next due, or drops it.
 *
 * In conformance mode (CONFORMANCE_TARGET=rust) each tick also runs on the
 * Rust server (`weldsuite cron desk-sla-sweep`), through `conformanceSweep`:
 * result, events, mail and due index must match, and the assertions below
 * check Rust's run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { generateId } from '@weldsuite/worker-kit/id';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { createDeskConversation } from '@weldsuite/db/lib/desk';

const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => dbs.tenant,
    getMasterDb: () => dbs.master,
  };
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

import { runSlaSweep, SLA_INDEX_SEED_KEY } from './sla-sweep';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const ORG = 'org_desk_sla';
const WORKSPACE = 'ws_desk_sla';
const MINUTE = 60_000;

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
  await master.insert(masterSchema.workspaces).values({
    id: WORKSPACE,
    name: 'Desk SLA',
    slug: 'desk-sla',
    clerkOrgId: ORG,
  } as typeof masterSchema.workspaces.$inferInsert);
  // The team an unassigned conversation's alert goes to.
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_sla_ann', userId: 'user_sla_ann', name: 'Ann', status: 'ACTIVE', memberType: 'INTERNAL', role: 'MEMBER' },
    { id: 'wm_sla_vic', userId: 'user_sla_vic', name: 'Vic', status: 'ACTIVE', memberType: 'INTERNAL', role: 'VIEWER' },
  ] as Array<typeof schema.workspaceMembers.$inferInsert>);
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schema.deskSlaClocks);
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.helpdeskSlas);
  await db.delete(schema.helpdeskSettings);
  await db.delete(schema.notifications);
  published.splice(0);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

function makeEnv() {
  return {
    ENVIRONMENT: 'test',
    SCHEDULE_INDEX: createSqliteD1(MIGRATION),
    WORKSPACE_CACHE: createMemoryKv(),
  };
}

const swept = new WeakSet<object>();

/** Mark the workspace due in the test's D1 index and, for Rust, in the master one. */
async function markDue(env: ReturnType<typeof makeEnv>, at: Date) {
  // The harness clears the master index the first time it sees a D1 (a new,
  // empty index): let that happen before the row goes in.
  if (!swept.has(env.SCHEDULE_INDEX)) {
    swept.add(env.SCHEDULE_INDEX);
    expect(await sweep(env, new Date(0))).toMatchObject({ due: 0, announced: 0 });
  }
  await markWorkspaceDue(env.SCHEDULE_INDEX as never, 'desk_sla', ORG, at);
  if (conformanceTarget()) {
    await master.execute(sql`
      insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
      values ('desk_sla', ${WORKSPACE}, ${at.toISOString()}::timestamptz, now(), 1)
      on conflict (kind, workspace_id) do update set
        next_due_at = least(workspace_due_index.next_due_at, excluded.next_due_at)`);
  }
}

/** The due index's time for the workspace, in ms; null when it has no row. */
async function dueAt(env: ReturnType<typeof makeEnv>): Promise<number | null> {
  const { results } = await (env.SCHEDULE_INDEX as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('desk_sla', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

/** `runSlaSweep(env, now)`, on both backends in conformance mode. */
function sweep(env: ReturnType<typeof makeEnv>, now: Date) {
  return conformanceSweep({
    job: 'desk-sla-sweep',
    now,
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: env as unknown as Record<string, unknown>,
    dueIndex: { d1: env.SCHEDULE_INDEX as never, kind: 'desk_sla' },
    kv: env.WORKSPACE_CACHE as object,
    seeded: env.WORKSPACE_CACHE.store.has(SLA_INDEX_SEED_KEY),
    workspaces: { [WORKSPACE]: ORG },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        return await runSlaSweep(env as never, now);
      } finally {
        dbs.tenant = db;
      }
    },
    takeTypeScriptEvents: () => published.splice(0),
    // The assertions on `published` then check Rust's events.
    onRustEvents: (events) => void published.push(...events),
  });
}

async function addPolicy(fields: Partial<typeof schema.helpdeskSlas.$inferInsert> = {}) {
  const at = new Date('2026-01-01T00:00:00Z');
  await db.insert(schema.helpdeskSlas).values({
    id: 'sla_sweep_standard',
    name: 'Standard',
    createdAt: at,
    updatedAt: at,
    isDefault: true,
    isActive: true,
    operationalHours: '24x7',
    firstResponseTime: [{ priority: 'medium', time: 60 }],
    resolutionTime: [{ priority: 'medium', time: 480 }],
    updateTime: [{ priority: 'medium', time: 120 }],
    ...fields,
  });
}

const slaEvents = (conversationId: string) =>
  db
    .select()
    .from(schema.deskMessages)
    .where(and(eq(schema.deskMessages.conversationId, conversationId), eq(schema.deskMessages.kind, 'event')))
    .then((rows) => rows.map((r) => r.metadata?.eventType).filter((t) => String(t).startsWith('sla_')));

describe('desk SLA sweep on the due index', () => {
  it('warns, then breaches, each once, and keeps the workspace due for the next clock', async () => {
    await addPolicy();
    const env = makeEnv();
    const { conversation, message, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_sweep',
      body: 'Where is my order?',
    });
    const start = message.createdAt.getTime();
    expect(slaCheckAt?.getTime()).toBe(start + 45 * MINUTE);
    await markDue(env, slaCheckAt!);

    // Not due yet: the tenant is not opened.
    expect(await sweep(env, new Date(start + 30 * MINUTE))).toMatchObject({ due: 0, announced: 0 });

    expect(await sweep(env, new Date(start + 50 * MINUTE))).toMatchObject({ due: 1, processed: 1, announced: 1 });
    expect(published.map((e) => [e.entityType, e.action, e.entityId])).toEqual([
      ['desk_conversation', 'sla_warning', conversation.id],
    ]);
    expect((published[0]?.data as Record<string, unknown>).slaAlertMetric).toBe('first_response');
    // Next: the breach.
    expect(await dueAt(env)).toBe(start + 60 * MINUTE);

    // The alert went to the team (no assignee): the active member, not the viewer.
    const notes = await db.select().from(schema.notifications);
    expect(notes.map((n) => [n.userId, n.notificationType, n.severity])).toEqual([
      ['user_sla_ann', 'sla_warning', 'warning'],
    ]);
    expect(notes[0]?.title).toBe('SLA due soon: First response');

    published.splice(0);
    expect(await sweep(env, new Date(start + 61 * MINUTE))).toMatchObject({ due: 1, announced: 1 });
    expect(published.map((e) => e.action)).toEqual(['sla_breached']);
    // First response is announced; resolution warns at 360 minutes.
    expect(await dueAt(env)).toBe(start + 360 * MINUTE);
    expect(await slaEvents(conversation.id)).toEqual(['sla_warning', 'sla_breached']);
    const [after] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, conversation.id));
    expect(after).toMatchObject({ slaStatus: 'breached', slaMetric: 'first_response' });
  });

  it('honours notifyOnSLABreach and tells the assignee only', async () => {
    await addPolicy({ firstResponseTime: [{ priority: 'urgent', time: 30 }], resolutionTime: null, updateTime: null });
    const env = makeEnv();
    const { conversation, message } = await createDeskConversation(db, { generateId, visitorId: 'v_urgent', body: 'Down!' });
    await db
      .update(schema.deskConversations)
      .set({ priority: 'urgent', assigneeId: 'user_sla_bob', title: 'Shop is down' })
      .where(eq(schema.deskConversations.id, conversation.id));
    // Re-derive on the new priority, as an attribute change does.
    const { appendDeskMessage } = await import('@weldsuite/db/lib/desk');
    const changed = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'event',
      authorType: 'agent',
      metadata: { eventType: 'attributes_changed', changes: [] },
    });
    const start = message.createdAt.getTime();
    // 30 minutes, warned 8 (25%, rounded) before.
    expect(changed.slaCheckAt?.getTime()).toBe(start + 22 * MINUTE);
    await markDue(env, changed.slaCheckAt!);

    expect(await sweep(env, new Date(start + 25 * MINUTE))).toMatchObject({ announced: 1 });
    const notes = await db.select().from(schema.notifications);
    expect(notes.map((n) => [n.userId, n.body])).toEqual([['user_sla_bob', '"Shop is down" reaches its first response target soon']]);

    // The workspace turned SLA notifications off: the breach is still announced, nobody is notified.
    await db.insert(schema.helpdeskSettings).values({ id: 'hds_sla', notifications: { notifyOnSLABreach: false } } as never);
    expect(await sweep(env, new Date(start + 31 * MINUTE))).toMatchObject({ announced: 1 });
    expect(await db.select().from(schema.notifications)).toHaveLength(1);
    // Nothing left to look at: the row is dropped.
    expect(await dueAt(env)).toBeNull();
  });

  it("counts on the workspace's business hours when the policy has none", async () => {
    await db.insert(schema.helpdeskSettings).values({
      id: 'hds_hours',
      general: {
        businessHours: {
          timezone: 'Europe/Amsterdam',
          monday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          tuesday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          wednesday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          thursday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          friday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          saturday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          sunday: { isOpen: true, openTime: '00:00', closeTime: '24:00' },
          holidays: [],
        },
      },
    } as never);
    await addPolicy({ operationalHours: 'business', businessHours: null });
    const env = makeEnv();
    const { conversation, message, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_hours',
      body: 'Hello?',
    });
    const start = message.createdAt.getTime();
    // Open around the clock: business time is wall-clock time.
    expect(slaCheckAt?.getTime()).toBe(start + 45 * MINUTE);
    const [clock] = await db
      .select()
      .from(schema.deskSlaClocks)
      .where(and(eq(schema.deskSlaClocks.conversationId, conversation.id), eq(schema.deskSlaClocks.metric, 'first_response')));
    expect((clock?.calendar as { timezone?: string } | null)?.timezone).toBe('Europe/Amsterdam');
    await markDue(env, slaCheckAt!);
    expect(await sweep(env, new Date(start + 46 * MINUTE))).toMatchObject({ announced: 1 });
  });

  it('drops a due workspace that has no clocks', async () => {
    const env = makeEnv();
    await markDue(env, new Date(Date.now() - MINUTE));
    expect(await sweep(env, new Date())).toMatchObject({ due: 1, processed: 1, failed: 0, announced: 0 });
    expect(await dueAt(env)).toBeNull();
  });
});
