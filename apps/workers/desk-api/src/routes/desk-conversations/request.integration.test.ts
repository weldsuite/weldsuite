/**
 * Service requests on pglite: making a conversation a request of a catalogue
 * item with none, one and two approval steps; deciding them in order (approve,
 * next step, approved, fulfilment tasks linked to the conversation with their
 * due dates; reject skipping the rest); who may decide; a double decision;
 * the refusals; that every approval event stays internal; and running a
 * fulfilment that stopped half way again. Seeded rows have fixed ids and
 * timestamps, so the suite runs against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import { deskFulfilmentEventId, deskFulfilmentTaskId } from '@weldsuite/db/lib/desk-catalog';
import {
  deskConversationRequestChangeSchema,
  deskConversationRequestOrNullSchema,
  deskRequestFulfilmentSchema,
} from '@weldsuite/core-api-client/schemas/desk-catalog';
import type { Env, Variables } from '../../types';
import { deskConversationsRoutes } from './index';
import { deskConversationRequestRoutes } from './request';

vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/desk/conversations';

let db: Database;

const routes = new Hono<{ Bindings: Env; Variables: Variables }>()
  .route('/', deskConversationsRoutes)
  .route('/', deskConversationRequestRoutes);

const app = (keys: string[], userId = 'user_test_default') =>
  createTestApp(BASE, routes, {
    context: { permissions: permissions(...keys), tenantDb: db, userId },
    env: { DATABASE_URL_MASTER: undefined } as never,
  });
const reader = (userId?: string) => app(['conversations:read'], userId);
const agent = (userId?: string) => app(['conversations:read', 'conversations:update'], userId);
const manager = () => app(['conversations:read', 'conversations:update', 'settings:update']);

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

async function seed(id: string, conversationNumber: number, values: Partial<typeof schema.deskConversations.$inferInsert> = {}) {
  await db.insert(schema.deskConversations).values({
    id,
    conversationNumber,
    createdAt: at(conversationNumber % 60),
    updatedAt: at(conversationNumber % 60),
    lastMessageAt: at(conversationNumber % 60),
    visitorId: `vis_${id}`,
    name: `Customer ${conversationNumber}`,
    ...values,
  });
}

async function row(id: string) {
  const [found] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  return found!;
}

const tasksOf = (conversationId: string) =>
  db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.sourceType, 'desk_conversation'), eq(schema.tasks.sourceId, conversationId)));

const eventsOf = async (conversationId: string, type: string) => {
  const rows = await db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversationId));
  return rows.filter((m) => m.metadata?.eventType === type);
};

interface Request {
  item: { id: string; name: string } | null;
  approvalStatus: 'pending' | 'approved' | 'rejected' | null;
  approvals: Array<{ stepIndex: number; stepName: string | null; approverId: string | null; status: string; decidedById: string | null; comment: string | null }>;
  fulfilmentStarted: boolean;
}
interface Change {
  data: { conversation: { id: string; ticketTypeId: string | null; departmentId: string | null; priority: string | null; catalogItemId: string | null; approvalStatus: string | null }; messages: DeskMessage[]; request: Request };
}
interface ErrorBody {
  error: { details: { reason?: string; field?: string } };
}

const types = (messages: DeskMessage[]) => messages.map((m) => m.metadata?.eventType);

async function attach(conversationId: string, catalogItemId: string, who = agent()) {
  const test = who;
  const res = await test.request(`${BASE}/${conversationId}/catalog-item`, send({ catalogItemId }, 'PUT'));
  return { res, test };
}

async function decide(conversationId: string, body: Record<string, unknown>, who = agent('user_alice')) {
  const res = await who.request(`${BASE}/${conversationId}/approval`, send(body));
  await who.settled();
  return res;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_default', userId: 'user_test_default', name: 'Default Agent' },
    { id: 'wm_alice', userId: 'user_alice', name: 'Alice' },
    { id: 'wm_bob', userId: 'user_bob', name: 'Bob' },
    { id: 'wm_mgr', userId: 'user_mgr', name: 'Maya Manager' },
  ]);
  await db.insert(schema.helpdeskTicketTypes).values([
    { id: 'ttyp_hw', name: 'Hardware request', category: 'customer', isActive: true },
    { id: 'ttyp_access', name: 'Access request', category: 'customer', isActive: true },
  ]);
  await db.insert(schema.helpdeskDepartments).values({ id: 'dept_it', name: 'IT', isActive: true, managerId: 'wm_mgr' });
  const base = { createdAt: at(0), updatedAt: at(0) };
  await db.insert(schema.deskCatalogItems).values([
    {
      ...base,
      id: 'dcat_plain',
      name: 'Headset',
      ticketTypeId: 'ttyp_hw',
      departmentId: 'dept_it',
      priority: 'low',
      fulfilmentTasks: [
        { id: 't1', title: 'Order the headset', assigneeId: 'user_alice', dueInDays: 2 },
        { id: 't2', title: 'Hand it over', dueInDays: 0 },
      ],
    },
    {
      ...base,
      id: 'dcat_one',
      name: 'Laptop',
      ticketTypeId: 'ttyp_hw',
      approvalSteps: [{ id: 's1', name: 'Budget', approverType: 'member', approverId: 'user_alice' }],
      fulfilmentTasks: [{ id: 't1', title: 'Order the laptop', dueInDays: 5 }],
    },
    {
      ...base,
      id: 'dcat_two',
      name: 'Server access',
      ticketTypeId: 'ttyp_access',
      approvalSteps: [
        { id: 's1', name: 'Line manager', approverType: 'member', approverId: 'user_alice' },
        { id: 's2', name: 'IT manager', approverType: 'team_manager', departmentId: 'dept_it' },
      ],
      fulfilmentTasks: [{ id: 't1', title: 'Create the account' }],
    },
    {
      ...base,
      id: 'dcat_team',
      name: 'Shared mailbox',
      ticketTypeId: 'ttyp_access',
      approvalSteps: [{ id: 's1', name: 'Owner', approverType: 'team_manager' }],
      fulfilmentTasks: [{ id: 't1', title: 'Create the mailbox' }],
    },
    { ...base, id: 'dcat_off', name: 'Switched off', ticketTypeId: 'ttyp_hw', isActive: false },
  ]);

  await seed('dconv_plain', 901, { assigneeId: 'user_bob' });
  await seed('dconv_one', 902);
  await seed('dconv_two', 903);
  await seed('dconv_reject', 904);
  await seed('dconv_team', 905);
  await seed('dconv_team_orphan', 906);
  await seed('dconv_team_dept', 907, { departmentId: 'dept_it' });
  await seed('dconv_race', 908);
  await seed('dconv_closed', 909, { state: 'closed' });
  await seed('dconv_merged', 910, { mergedIntoId: 'dconv_plain' });
  await seed('dconv_plain_2', 911);
  await seed('dconv_gone', 912);
  await seed('dconv_not_request', 913);
  // Requests whose fulfilment stopped: after one of two tasks, and before the first.
  await seed('dconv_half', 921, { catalogItemId: 'dcat_plain', assigneeId: 'user_bob' });
  await db.insert(schema.tasks).values({
    id: 'task_half_1',
    title: 'Order the headset',
    sourceType: 'desk_conversation',
    sourceId: 'dconv_half',
    assigneeId: 'user_alice',
    createdAt: at(21),
    updatedAt: at(21),
  });
  await seed('dconv_stalled', 922, { catalogItemId: 'dcat_one', approvalStatus: 'approved' });
  // A request whose first task another run made (under the id every run gives it), renamed by an agent since.
  await seed('dconv_taken', 930, { catalogItemId: 'dcat_plain', assigneeId: 'user_bob' });
  await db.insert(schema.tasks).values({
    id: await deskFulfilmentTaskId('dconv_taken', 't1'),
    title: 'Order two headsets',
    sourceType: 'desk_conversation',
    sourceId: 'dconv_taken',
    assigneeId: 'user_alice',
    createdAt: at(23),
    updatedAt: at(23),
  });
}, 60_000);

describe('PUT /api/desk/conversations/:id/catalog-item without approval steps', () => {
  it("applies the item's type, team and priority, starts the request and creates its tasks linked to the conversation", async () => {
    const { res, test } = await attach('dconv_plain', 'dcat_plain');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation).toMatchObject({
      catalogItemId: 'dcat_plain',
      approvalStatus: null,
      ticketTypeId: 'ttyp_hw',
      departmentId: 'dept_it',
      priority: 'low',
    });
    expect(types(data.messages)).toEqual(['attributes_changed']);
    // The tasks are made after the answer: they are not there yet.
    expect(data.request).toEqual({
      item: { id: 'dcat_plain', name: 'Headset', category: null, icon: null, deliveryEstimate: null, fulfilmentTaskCount: 2 },
      approvalStatus: null,
      approvals: [],
      fulfilmentStarted: false,
    });

    await test.settled();
    const tasks = (await tasksOf('dconv_plain')).sort((a, b) => a.title.localeCompare(b.title));
    expect(tasks.map((t) => t.title)).toEqual(['Hand it over', 'Order the headset']);
    // The template's assignee, else the conversation's owner.
    expect(tasks.map((t) => t.assigneeId)).toEqual(['user_bob', 'user_alice']);
    const day = 86_400_000;
    const due = (title: string) => new Date(tasks.find((t) => t.title === title)!.dueDate!).getTime() - Date.now();
    expect(Math.abs(due('Order the headset') - 2 * day)).toBeLessThan(60_000);
    expect(Math.abs(due('Hand it over'))).toBeLessThan(60_000);
    expect(tasks.every((t) => t.projectId === null)).toBe(true);

    const started = await eventsOf('dconv_plain', 'fulfilment_started');
    expect(started).toHaveLength(1);
    expect(started[0]?.metadata?.taskIds).toEqual(expect.arrayContaining(tasks.map((t) => t.id)));
  });

  it('is a request now: one item per conversation, and the request is readable', async () => {
    const again = await attach('dconv_plain', 'dcat_one');
    expect(again.res.status).toBe(409);
    expect(((await again.res.json()) as ErrorBody).error.details.reason).toBe('already_request');
    const read = (await (await reader().request(`${BASE}/dconv_plain/request`)).json()) as { data: Request };
    expect(read.data.item?.name).toBe('Headset');
    expect(read.data.fulfilmentStarted).toBe(true);
    expect(await tasksOf('dconv_plain')).toHaveLength(2);
  });
});

describe('PUT /api/desk/conversations/:id/catalog-item with approval steps', () => {
  it('starts the first step pending, the rest waiting, with an internal approval_requested event and no tasks yet', async () => {
    const { res, test } = await attach('dconv_two', 'dcat_two');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation).toMatchObject({ catalogItemId: 'dcat_two', approvalStatus: 'pending' });
    expect(types(data.messages)).toEqual(['attributes_changed', 'approval_requested']);
    const requested = data.messages[1]!;
    expect(requested.metadata).toMatchObject({
      stepIndex: 0,
      stepName: 'Line manager',
      approverId: 'user_alice',
      catalogItemId: 'dcat_two',
      catalogItemName: 'Server access',
    });
    expect(isPublicDeskMessage(requested)).toBe(false);
    expect(data.request.approvals.map((a) => [a.stepIndex, a.stepName, a.approverId, a.status])).toEqual([
      [0, 'Line manager', 'user_alice', 'pending'],
      [1, 'IT manager', 'user_mgr', 'waiting'],
    ]);
    await test.settled();
    expect(await tasksOf('dconv_two')).toHaveLength(0);
    // The approver hears about it.
    const notified = await db.select().from(schema.notifications).where(eq(schema.notifications.entityId, 'dconv_two'));
    expect(notified.map((n) => [n.userId, n.title])).toEqual([['user_alice', 'Approval needed: Server access for Customer 903']]);
  });

  it("resolves a team step to the team's manager: the step's team, else the conversation's, else nobody", async () => {
    await attach('dconv_team_dept', 'dcat_team');
    const withTeam = (await (await reader().request(`${BASE}/dconv_team_dept/request`)).json()) as { data: Request };
    expect(withTeam.data.approvals[0]).toMatchObject({ approverId: 'user_mgr', status: 'pending' });

    await attach('dconv_team_orphan', 'dcat_team');
    const without = (await (await reader().request(`${BASE}/dconv_team_orphan/request`)).json()) as { data: Request };
    expect(without.data.approvals[0]).toMatchObject({ approverId: null, status: 'pending' });
  });

  it('refuses a closed, a merged and a switched-off request, an unknown item and an unknown conversation', async () => {
    const reason = async (res: Response) => ((await res.json()) as ErrorBody).error.details.reason;
    const closed = await attach('dconv_closed', 'dcat_one');
    expect(closed.res.status).toBe(409);
    expect(await reason(closed.res)).toBe('closed');
    const merged = await attach('dconv_merged', 'dcat_one');
    expect(await reason(merged.res)).toBe('merged');
    const off = await attach('dconv_not_request', 'dcat_off');
    expect(off.res.status).toBe(409);
    expect(await reason(off.res)).toBe('item_inactive');
    expect((await attach('dconv_not_request', 'dcat_nope')).res.status).toBe(404);
    expect((await attach('dconv_nope', 'dcat_one')).res.status).toBe(404);
    // Nothing was changed on the way.
    expect((await row('dconv_not_request')).catalogItemId).toBeNull();
    expect((await row('dconv_closed')).ticketTypeId).toBeNull();
  });

  it('needs conversations:update and a catalogue item id', async () => {
    expect((await reader().request(`${BASE}/dconv_not_request/catalog-item`, send({ catalogItemId: 'dcat_one' }, 'PUT'))).status).toBe(403);
    expect((await agent().request(`${BASE}/dconv_not_request/catalog-item`, send({}, 'PUT'))).status).toBe(400);
  });
});

describe('POST /api/desk/conversations/:id/approval', () => {
  it('approves the only step: approved, an approval_approved event and the tasks, due as the item says', async () => {
    await attach('dconv_one', 'dcat_one');
    const res = await decide('dconv_one', { decision: 'approved', comment: 'Within budget' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation.approvalStatus).toBe('approved');
    expect(types(data.messages)).toEqual(['approval_approved']);
    expect(data.messages[0]?.metadata).toMatchObject({ stepIndex: 0, decidedById: 'user_alice', comment: 'Within budget' });
    expect(isPublicDeskMessage(data.messages[0]!)).toBe(false);
    expect(data.request.approvals[0]).toMatchObject({ status: 'approved', decidedById: 'user_alice', comment: 'Within budget' });
    expect(data.request.fulfilmentStarted).toBe(false);

    const tasks = await tasksOf('dconv_one');
    expect(tasks.map((t) => t.title)).toEqual(['Order the laptop']);
    expect(Math.abs(new Date(tasks[0]!.dueDate!).getTime() - Date.now() - 5 * 86_400_000)).toBeLessThan(60_000);
    expect(await eventsOf('dconv_one', 'fulfilment_started')).toHaveLength(1);
  });

  it('opens the next step on approval and approves the request only after the last one', async () => {
    const first = (await (await decide('dconv_two', { decision: 'approved' })).json()) as Change;
    expect(types(first.data.messages)).toEqual(['approval_approved', 'approval_requested']);
    expect(first.data.conversation.approvalStatus).toBe('pending');
    expect(first.data.request.approvals.map((a) => a.status)).toEqual(['approved', 'pending']);
    expect(first.data.messages[1]?.metadata).toMatchObject({ stepIndex: 1, stepName: 'IT manager', approverId: 'user_mgr' });
    expect(await tasksOf('dconv_two')).toHaveLength(0);
    const notified = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, 'user_mgr'));
    expect(notified.map((n) => n.entityId)).toContain('dconv_two');

    // The first approver can't decide the second step.
    const wrong = await decide('dconv_two', { decision: 'approved' });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as ErrorBody).error.details.reason).toBe('not_approver');

    const last = (await (await decide('dconv_two', { decision: 'approved' }, agent('user_mgr'))).json()) as Change;
    expect(last.data.conversation.approvalStatus).toBe('approved');
    expect(types(last.data.messages)).toEqual(['approval_approved']);
    expect((await tasksOf('dconv_two')).map((t) => t.title)).toEqual(['Create the account']);
  });

  it('rejects: the later steps are skipped, the request is rejected and no tasks are made', async () => {
    await attach('dconv_reject', 'dcat_two');
    const res = await decide('dconv_reject', { decision: 'rejected', comment: 'Not needed' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation.approvalStatus).toBe('rejected');
    expect(types(data.messages)).toEqual(['approval_rejected']);
    expect(data.messages[0]?.metadata).toMatchObject({ comment: 'Not needed', decidedById: 'user_alice' });
    expect(data.request.approvals.map((a) => a.status)).toEqual(['rejected', 'skipped']);
    expect(await tasksOf('dconv_reject')).toHaveLength(0);
    expect(await eventsOf('dconv_reject', 'fulfilment_started')).toHaveLength(0);

    const again = await decide('dconv_reject', { decision: 'approved' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.details.reason).toBe('not_pending');
  });

  it('lets a catalogue manager decide any step, and a step without an approver only a manager', async () => {
    await attach('dconv_team', 'dcat_team');
    const nobody = await decide('dconv_team', { decision: 'approved' }, agent('user_bob'));
    expect(nobody.status).toBe(409);
    expect(((await nobody.json()) as ErrorBody).error.details.reason).toBe('not_approver');

    const override = await decide('dconv_team', { decision: 'approved' }, manager());
    expect(override.status).toBe(200);
    const { data } = (await override.json()) as Change;
    expect(data.request.approvals[0]).toMatchObject({ approverId: null, status: 'approved', decidedById: 'user_test_default' });
    expect((await tasksOf('dconv_team')).map((t) => t.title)).toEqual(['Create the mailbox']);
  });

  it('decides a step once when two decisions arrive together', async () => {
    await attach('dconv_race', 'dcat_one');
    const alice = agent('user_alice');
    const [a, b] = await Promise.all([
      alice.request(`${BASE}/dconv_race/approval`, send({ decision: 'approved' })),
      alice.request(`${BASE}/dconv_race/approval`, send({ decision: 'approved' })),
    ]);
    await alice.settled();
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await eventsOf('dconv_race', 'approval_approved')).toHaveLength(1);
    expect(await tasksOf('dconv_race')).toHaveLength(1);
  });

  it('refuses a conversation that is not a request, validates the body and needs conversations:read', async () => {
    const none = await decide('dconv_not_request', { decision: 'approved' });
    expect(none.status).toBe(409);
    expect(((await none.json()) as ErrorBody).error.details.reason).toBe('not_pending');
    expect((await decide('dconv_nope', { decision: 'approved' })).status).toBe(404);
    expect((await decide('dconv_not_request', { decision: 'maybe' })).status).toBe(400);
    expect((await app(['tickets:read']).request(`${BASE}/dconv_not_request/approval`, send({ decision: 'approved' }))).status).toBe(403);
  });

  it('keeps working after the item is deleted: the decision is recorded, no tasks are made', async () => {
    await seed('dconv_orphan', 914);
    await db.insert(schema.deskCatalogItems).values({
      id: 'dcat_gone',
      name: 'Short lived',
      ticketTypeId: 'ttyp_hw',
      approvalSteps: [{ id: 's1', approverType: 'member', approverId: 'user_alice' }],
      fulfilmentTasks: [{ id: 't1', title: 'Never made' }],
    });
    await attach('dconv_orphan', 'dcat_gone');
    await db.delete(schema.deskCatalogItems).where(eq(schema.deskCatalogItems.id, 'dcat_gone'));
    const res = await decide('dconv_orphan', { decision: 'approved' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.request.item).toBeNull();
    expect(data.request.approvalStatus).toBe('approved');
    expect(await tasksOf('dconv_orphan')).toHaveLength(0);
  });
});

describe('POST /api/desk/conversations/:id/fulfilment', () => {
  const retry = (conversationId: string, who = agent()) => who.request(`${BASE}/${conversationId}/fulfilment`, { method: 'POST' });
  const reason = async (res: Response) => ((await res.json()) as ErrorBody).error.details.reason;
  const started = async (conversationId: string) =>
    ((await (await reader().request(`${BASE}/${conversationId}/request`)).json()) as { data: Request }).data.fulfilmentStarted;

  it('creates only the tasks a run that stopped half way did not get to', async () => {
    expect(await started('dconv_half')).toBe(false);
    const res = await retry('dconv_half');
    expect(res.status).toBe(200);
    // Not after the answer: the tasks are there when it comes.
    expect(await res.json()).toEqual({ data: { created: 1 } });
    const tasks = (await tasksOf('dconv_half')).sort((a, b) => a.title.localeCompare(b.title));
    expect(tasks.map((t) => [t.title, t.assigneeId])).toEqual([
      ['Hand it over', 'user_bob'],
      ['Order the headset', 'user_alice'],
    ]);
    expect(tasks.map((t) => t.id)).toContain('task_half_1');
    // One timeline entry, naming both tasks in the item's order, by the member who ran it.
    const events = await eventsOf('dconv_half', 'fulfilment_started');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'event', authorType: 'agent', authorId: 'user_test_default' });
    expect(events[0]?.metadata?.taskIds).toEqual(['task_half_1', tasks[0]!.id]);
    expect(isPublicDeskMessage(events[0]!)).toBe(false);
    expect(await started('dconv_half')).toBe(true);
  });

  it('creates every task when the run never got to the first, and only once', async () => {
    const res = await retry('dconv_stalled');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { created: 1 } });
    expect((await tasksOf('dconv_stalled')).map((t) => t.title)).toEqual(['Order the laptop']);

    const again = await retry('dconv_stalled');
    expect(again.status).toBe(409);
    expect(await reason(again)).toBe('already_started');
    expect(await tasksOf('dconv_stalled')).toHaveLength(1);
    expect(await eventsOf('dconv_stalled', 'fulfilment_started')).toHaveLength(1);
  });

  it('gives a task and the timeline entry the id every run gives them, so neither is made twice', async () => {
    const firstId = await deskFulfilmentTaskId('dconv_taken', 't1');
    const secondId = await deskFulfilmentTaskId('dconv_taken', 't2');
    const res = await retry('dconv_taken');
    expect(res.status).toBe(200);
    // The first task was there under its id (its title no longer matches the template): only the second is made.
    expect(await res.json()).toEqual({ data: { created: 1 } });
    const tasks = (await tasksOf('dconv_taken')).sort((a, b) => a.title.localeCompare(b.title));
    expect(tasks.map((t) => [t.id, t.title])).toEqual([
      [secondId, 'Hand it over'],
      [firstId, 'Order two headsets'],
    ]);
    const events = await eventsOf('dconv_taken', 'fulfilment_started');
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(await deskFulfilmentEventId('dconv_taken'));
    expect(events[0]?.metadata?.taskIds).toEqual([firstId, secondId]);
  });

  it('refuses what is not a request, not approved, started already or without its item', async () => {
    const none = await retry('dconv_gone');
    expect(none.status).toBe(409);
    expect(await reason(none)).toBe('not_request');
    // Waiting for its approver, and rejected.
    expect(await reason(await retry('dconv_team_orphan'))).toBe('not_approved');
    expect(await reason(await retry('dconv_reject'))).toBe('not_approved');
    expect(await reason(await retry('dconv_plain'))).toBe('already_started');
    // Approved after its item was deleted: there is nothing to create the tasks from.
    const missing = await retry('dconv_orphan');
    expect(missing.status).toBe(409);
    expect(await reason(missing)).toBe('item_missing');
    expect(await tasksOf('dconv_orphan')).toHaveLength(0);
    expect((await retry('dconv_nope')).status).toBe(404);
  });

  it('needs conversations:update', async () => {
    expect((await retry('dconv_half', reader())).status).toBe(403);
  });
});

describe('GET /api/desk/conversations/:id/request', () => {
  it('answers null for a conversation that is not a request and 404 for an unknown one', async () => {
    const res = await reader().request(`${BASE}/dconv_gone/request`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    expect((await reader().request(`${BASE}/dconv_nope/request`)).status).toBe(404);
  });

  it('lists the steps in order and needs conversations:read', async () => {
    const { data } = (await (await reader().request(`${BASE}/dconv_reject/request`)).json()) as { data: Request };
    expect(data.approvals.map((a) => a.stepIndex)).toEqual([0, 1]);
    expect((await app(['tickets:read']).request(`${BASE}/dconv_reject/request`)).status).toBe(403);
  });
});

describe('the answers match their published schemas', () => {
  const body = async (res: Response) => ((await res.json()) as { data: unknown }).data;

  it('for a request with decided steps, a new request and a decision', async () => {
    // Strict schemas: a column the contract does not name fails the parse.
    const decided = await body(await reader().request(`${BASE}/dconv_reject/request`));
    expect(deskConversationRequestOrNullSchema.parse(decided)).toBeTruthy();
    expect(Object.keys((decided as Request).approvals[0]!).sort()).toEqual(
      ['approverId', 'comment', 'decidedAt', 'decidedById', 'id', 'status', 'stepIndex', 'stepName'],
    );

    const { res: started, test } = await attach('dconv_not_request', 'dcat_one');
    expect(started.status).toBe(200);
    expect(deskConversationRequestChangeSchema.parse(await body(started))).toBeTruthy();
    await test.settled();

    const approved = await decide('dconv_not_request', { decision: 'approved', comment: 'Fine by me' });
    expect(approved.status).toBe(200);
    expect(deskConversationRequestChangeSchema.parse(await body(approved))).toBeTruthy();

    // A fulfilment run again: how many tasks it created, and nothing else.
    await seed('dconv_schema', 923, { catalogItemId: 'dcat_one', approvalStatus: 'approved' });
    const retried = await agent().request(`${BASE}/dconv_schema/fulfilment`, { method: 'POST' });
    expect(retried.status).toBe(200);
    expect(deskRequestFulfilmentSchema.parse(await body(retried))).toEqual({ created: 1 });
  });
});
