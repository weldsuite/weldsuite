/**
 * Team escalation rules on the SLA sweep's due index, end to end: a desk
 * write stores `desk_conversations.escalationCheckAt` and returns it as the
 * conversation's `slaCheckAt`, the writer marks the workspace due, and
 * `runSlaSweep(env, now)` fires the rules that came due: an internal
 * `escalated` event, the hand-over (the team's manager, the next team), a
 * public notice when the rule says so, the `desk_conversation` entity events
 * and the new owner's notification; then the workspace is due again for
 * what is left, or dropped.
 *
 * In conformance mode (CONFORMANCE_TARGET=rust) each tick also runs on the
 * Rust server (`weldsuite cron desk-sla-sweep`) through `conformanceSweep`:
 * result, events, mail and due index must match, and the assertions below
 * check Rust's run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { generateId } from '@weldsuite/worker-kit/id';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { appendDeskMessage, createDeskConversation } from '@weldsuite/db/lib/desk';

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

const ORG = 'org_desk_esc';
const WORKSPACE = 'ws_desk_esc';
const MINUTE = 60_000;
const at = new Date('2026-01-01T00:00:00Z');

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
    name: 'Desk escalations',
    slug: 'desk-esc',
    clerkOrgId: ORG,
  } as typeof masterSchema.workspaces.$inferInsert);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_esc_mgr', userId: 'user_esc_mgr', name: 'Mia Manager', status: 'ACTIVE', memberType: 'INTERNAL', role: 'ADMIN' },
    { id: 'wm_esc_ann', userId: 'user_esc_ann', name: 'Ann', status: 'ACTIVE', memberType: 'INTERNAL', role: 'MEMBER' },
    { id: 'wm_esc_bob', userId: 'user_esc_bob', name: 'Bob', status: 'ACTIVE', memberType: 'INTERNAL', role: 'MEMBER' },
  ] as Array<typeof schema.workspaceMembers.$inferInsert>);
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schema.deskSlaClocks);
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.helpdeskDepartments);
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

async function markDue(env: ReturnType<typeof makeEnv>, due: Date) {
  if (!swept.has(env.SCHEDULE_INDEX)) {
    swept.add(env.SCHEDULE_INDEX);
    expect(await sweep(env, new Date(0))).toMatchObject({ due: 0, announced: 0 });
  }
  await markWorkspaceDue(env.SCHEDULE_INDEX as never, 'desk_sla', ORG, due);
  if (conformanceTarget()) {
    await master.execute(sql`
      insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
      values ('desk_sla', ${WORKSPACE}, ${due.toISOString()}::timestamptz, now(), 1)
      on conflict (kind, workspace_id) do update set
        next_due_at = least(workspace_due_index.next_due_at, excluded.next_due_at)`);
  }
}

async function dueAt(env: ReturnType<typeof makeEnv>): Promise<number | null> {
  const { results } = await (env.SCHEDULE_INDEX as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('desk_sla', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

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
    onRustEvents: (events) => void published.push(...events),
  });
}

const timeline = (conversationId: string) =>
  db
    .select()
    .from(schema.deskMessages)
    .where(eq(schema.deskMessages.conversationId, conversationId))
    .orderBy(asc(schema.deskMessages.createdAt), asc(schema.deskMessages.id));

const conversationRow = async (id: string) =>
  (await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id)))[0]!;

describe('desk escalation rules on the SLA sweep', () => {
  it('hands an unassigned conversation to the team manager once, and tells the customer', async () => {
    await db.insert(schema.helpdeskDepartments).values({
      id: 'dep_esc_front',
      name: 'Front desk',
      managerId: 'wm_esc_mgr',
      escalationRules: [
        { condition: 'custom', afterMinutes: 1, escalateTo: 'manager' },
        { condition: 'unassigned', afterMinutes: 15, escalateTo: 'manager', notifyCustomer: true },
      ],
      createdAt: at,
      updatedAt: at,
    });
    const env = makeEnv();
    const { conversation, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_esc_front',
      body: 'Anyone there?',
      departmentId: 'dep_esc_front',
    });
    // Unassigned since it opened. No SLA policy: the escalation check is the conversation's next check.
    const start = conversation.createdAt.getTime();
    expect(slaCheckAt?.getTime()).toBe(start + 15 * MINUTE);
    expect((await conversationRow(conversation.id)).escalationCheckAt?.getTime()).toBe(start + 15 * MINUTE);
    await markDue(env, slaCheckAt!);

    expect(await sweep(env, new Date(start + 10 * MINUTE))).toMatchObject({ due: 0 });
    expect(await sweep(env, new Date(start + 16 * MINUTE))).toMatchObject({ due: 1, processed: 1, failed: 0 });

    const after = await conversationRow(conversation.id);
    expect(after).toMatchObject({ assigneeId: 'user_esc_mgr', escalationCheckAt: null });
    const rows = await timeline(conversation.id);
    expect(rows.map((r) => [r.kind, r.authorType, r.metadata?.eventType ?? null])).toEqual([
      ['message', 'visitor', null],
      ['event', 'system', 'escalated'],
      ['event', 'system', 'assigned'],
      ['message', 'system', null],
    ]);
    expect(rows[1]!.metadata).toEqual({
      eventType: 'escalated',
      teamId: 'dep_esc_front',
      ruleIndex: 1,
      condition: 'unassigned',
      escalateTo: 'manager',
      assigneeId: 'user_esc_mgr',
    });
    expect(rows[2]!.metadata).toMatchObject({ assigneeId: 'user_esc_mgr', escalation: true });
    expect(rows[3]!.body).toMatch(/escalated/);
    expect(published.map((e) => [e.entityType, e.action])).toEqual([
      ['desk_conversation', 'updated'],
      ['desk_message', 'created'],
      ['desk_conversation', 'assigned'],
      ['desk_message', 'created'],
      ['desk_conversation', 'updated'],
      ['desk_message', 'created'],
    ]);
    const notes = await db.select().from(schema.notifications);
    expect(notes.map((n) => [n.userId, n.notificationType])).toEqual([['user_esc_mgr', 'ticket_assigned']]);
    // Nothing left: the workspace is dropped, and a later tick fires nothing again.
    expect(await dueAt(env)).toBeNull();
  });

  it('moves a conversation nobody answered to the next team, whose members take it', async () => {
    await db.insert(schema.helpdeskSettings).values({
      id: 'hds_esc',
      automation: { enabled: false, deskAssignment: { mode: 'balanced', memberIds: [], awayMemberIds: [], maxOpenPerMember: null } },
    });
    await db.insert(schema.helpdeskDepartments).values([
      {
        id: 'dep_esc_t1',
        name: 'Tier 1',
        sortOrder: 1,
        agentIds: ['user_esc_ann'],
        escalationRules: [{ condition: 'no_response', afterMinutes: 30, escalateTo: 'next_tier' }],
        createdAt: at,
        updatedAt: at,
      },
      { id: 'dep_esc_off', name: 'Retired', sortOrder: 2, isActive: false, createdAt: at, updatedAt: at },
      { id: 'dep_esc_t2', name: 'Tier 2', sortOrder: 3, agentIds: ['user_esc_bob'], createdAt: at, updatedAt: at },
    ]);
    const env = makeEnv();
    const { conversation, message } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_esc_tier',
      body: 'Still broken',
      departmentId: 'dep_esc_t1',
    });
    const assigned = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'event',
      authorType: 'agent',
      authorId: 'user_esc_ann',
      metadata: { eventType: 'assigned', assigneeId: 'user_esc_ann' },
      assigneeId: 'user_esc_ann',
    });
    const start = message.createdAt.getTime();
    expect(assigned.slaCheckAt?.getTime()).toBe(start + 30 * MINUTE);
    await markDue(env, assigned.slaCheckAt!);

    expect(await sweep(env, new Date(start + 31 * MINUTE))).toMatchObject({ due: 1, processed: 1, failed: 0 });
    const after = await conversationRow(conversation.id);
    expect(after).toMatchObject({ departmentId: 'dep_esc_t2', assigneeId: 'user_esc_bob', escalationCheckAt: null });
    const events = (await timeline(conversation.id)).filter((r) => r.kind === 'event').map((r) => r.metadata);
    expect(events.map((m) => m?.eventType)).toEqual(['assigned', 'escalated', 'attributes_changed', 'unassigned', 'assigned']);
    expect(events[1]).toMatchObject({ teamId: 'dep_esc_t1', ruleIndex: 0, escalateTo: 'next_tier', toTeamId: 'dep_esc_t2' });
    expect(events[4]).toMatchObject({ assigneeId: 'user_esc_bob', auto: true, teamId: 'dep_esc_t2' });
    expect(published.filter((e) => e.entityType === 'desk_conversation').map((e) => e.action)).toEqual([
      'updated',
      'updated',
      'assigned',
      'assigned',
    ]);
    expect(published.filter((e) => e.entityType === 'desk_message')).toHaveLength(4);
    const notes = await db.select().from(schema.notifications);
    expect(notes.map((n) => n.userId)).toEqual(['user_esc_bob']);
    expect(await dueAt(env)).toBeNull();
  });

  it('emails the notice to the customer of an email ticket', async () => {
    await db.insert(schema.helpdeskDepartments).values({
      id: 'dep_esc_mail',
      name: 'Mail desk',
      managerId: 'wm_esc_mgr',
      escalationRules: [{ condition: 'unassigned', afterMinutes: 15, escalateTo: 'manager', notifyCustomer: true }],
      createdAt: at,
      updatedAt: at,
    });
    const mail = createSendEmailStub();
    const env = { ...makeEnv(), SEND_EMAIL: mail };
    const { conversation, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      channel: 'email',
      visitorId: null,
      email: 'eve@shop.test',
      title: 'Refund',
      body: 'Where is my refund?',
      departmentId: 'dep_esc_mail',
      metadata: { helpdeskAddress: 'support@acme.test', emailMessageId: 'in-eve@shop.test' },
    });
    await markDue(env, slaCheckAt!);
    const start = conversation.createdAt.getTime();
    expect(await sweep(env, new Date(start + 16 * MINUTE))).toMatchObject({ processed: 1, failed: 0 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ from: 'support@acme.test', to: 'eve@shop.test' });
  });

  it('stops counting once the team answers', async () => {
    await db.insert(schema.helpdeskDepartments).values({
      id: 'dep_esc_quiet',
      name: 'Quiet',
      managerId: 'wm_esc_mgr',
      escalationRules: [{ condition: 'no_response', afterMinutes: 20, escalateTo: 'manager' }],
      createdAt: at,
      updatedAt: at,
    });
    const { conversation, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_esc_quiet',
      body: 'Hi',
      departmentId: 'dep_esc_quiet',
    });
    expect(slaCheckAt).not.toBeNull();
    const reply = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'agent',
      authorId: 'user_esc_ann',
      body: 'On it',
    });
    expect(reply.slaCheckAt).toBeNull();
    expect((await conversationRow(conversation.id)).escalationCheckAt).toBeNull();
    const rows = await db
      .select()
      .from(schema.deskMessages)
      .where(and(eq(schema.deskMessages.conversationId, conversation.id), eq(schema.deskMessages.kind, 'event')));
    expect(rows).toEqual([]);
  });
});
