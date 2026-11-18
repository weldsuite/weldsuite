/**
 * The service catalogue's shared pieces on pglite: the db lib (items, the
 * reader view with audiences, a help-center request, starting and deciding,
 * deleting an item that has requests, a failure between statements) and the
 * domain follow-up (fulfilment tasks linked to the conversation, once, and
 * completed by a second run after a failure; the approver notification). The
 * lib is `@weldsuite/db/lib/desk-catalog`; it lives here because the db
 * package has no pglite.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createDeskCatalogItem,
  createDeskCatalogPortalRequest,
  decideDeskRequestApproval,
  deleteDeskCatalogItem,
  deskFulfilmentEventId,
  deskFulfilmentTaskId,
  DeskCatalogItemInUseError,
  DeskCatalogRefusedError,
  DeskCatalogRejectedError,
  getDeskCatalogItem,
  getDeskConversationRequest,
  listDeskCatalogForPrincipal,
  listDeskCatalogItems,
  startDeskCatalogRequest,
  updateDeskCatalogItem,
} from '@weldsuite/db/lib/desk-catalog';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const notifications = vi.hoisted(() => ({
  notify: vi.fn(async (_params: { userId: string; title: string; entityId: string; actionUrl: string }) => 'ntf'),
  assigned: vi.fn(async (_params: { assigneeId: string; taskTitle: string }) => 'ntf'),
}));

vi.mock('@weldsuite/notifications', () => ({
  createAndDeliverNotification: notifications.notify,
  sendTaskAssignmentNotification: notifications.assigned,
}));

const { fulfilDeskCatalogRequest, notifyDeskApprover, runDeskCatalogFulfilment } = await import('./catalog');
type DeskCatalogContext = import('./catalog').DeskCatalogContext;

let db: Database;
const ctx: DeskCatalogContext = { env: {}, clerkOrgId: 'org_catalog', generateId };
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

async function seedConversation(id: string, number: number, values: Partial<typeof schema.deskConversations.$inferInsert> = {}) {
  await db.insert(schema.deskConversations).values({
    id,
    conversationNumber: number,
    name: `Customer ${number}`,
    createdAt: at(number % 60),
    updatedAt: at(number % 60),
    ...values,
  });
}

const tasksOf = (conversationId: string) =>
  db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.sourceType, 'desk_conversation'), eq(schema.tasks.sourceId, conversationId)));

const conversationOf = async (id: string) => {
  const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  return row!;
};

const stepsOf = (conversationId: string) =>
  db
    .select()
    .from(schema.deskRequestApprovals)
    .where(eq(schema.deskRequestApprovals.conversationId, conversationId))
    .orderBy(asc(schema.deskRequestApprovals.stepIndex));

const eventsOf = async (conversationId: string, type: string) => {
  const rows = await db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversationId));
  return rows.filter((message) => message.metadata?.eventType === type);
};

const WRITES = new Set<PropertyKey>(['insert', 'update', 'delete', 'execute']);

/**
 * `db`, failing its n-th write (an insert, update, delete or raw statement)
 * before it runs, as a dropped connection would. `writes()` is how many were
 * started.
 */
function failingOn(nth: number): { db: Database; writes: () => number } {
  let writes = 0;
  const handle = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (!WRITES.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        writes += 1;
        if (writes === nth) throw new Error(`statement ${nth} failed`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: handle, writes: () => writes };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_a', userId: 'user_a', name: 'Alice' },
    { id: 'wm_b', userId: 'user_b', name: 'Bob' },
  ]);
  await db.insert(schema.helpdeskTicketTypes).values([
    { id: 'ttyp_ok', name: 'Request', category: 'customer', fields: [] },
    { id: 'ttyp_internal', name: 'Internal', category: 'internal', fields: [] },
  ]);
  await db.insert(schema.companies).values({ id: 'co_1', name: 'Acme', displayName: 'Acme' });
  await db.insert(schema.people).values({ id: 'per_1', displayName: 'Pat', email: 'pat@acme.test' });
  await db.insert(schema.personCompanies).values({ id: 'pc_1', personId: 'per_1', companyId: 'co_1' });
}, 60_000);

describe('items', () => {
  it('creates, changes and deletes an item with a typed rejection for a bad form', async () => {
    const item = await createDeskCatalogItem(db, {
      generateId,
      name: '  Monitor ',
      ticketTypeId: 'ttyp_ok',
      category: 'Hardware',
      fulfilmentTasks: [{ title: 'Order it', dueInDays: 4 }],
    });
    expect(item).toMatchObject({ name: 'Monitor', isActive: true, sortOrder: 0, approvalSteps: [] });
    expect(item.id.startsWith('dcat_')).toBe(true);

    const changed = await updateDeskCatalogItem(db, item.id, { generateId, category: null, sortOrder: 3 });
    expect(changed).toMatchObject({ name: 'Monitor', category: null, sortOrder: 3 });
    expect(await updateDeskCatalogItem(db, 'dcat_nope', { generateId, name: 'x' })).toBeNull();

    const bad = createDeskCatalogItem(db, { generateId, name: 'Bad', ticketTypeId: 'ttyp_internal' });
    await expect(bad).rejects.toBeInstanceOf(DeskCatalogRejectedError);
    await expect(bad).rejects.toMatchObject({ field: 'ticketTypeId' });

    expect((await listDeskCatalogItems(db)).map((i) => i.id)).toContain(item.id);
    expect((await deleteDeskCatalogItem(db, item.id))?.id).toBe(item.id);
    expect(await getDeskCatalogItem(db, item.id)).toBeNull();
    expect(await deleteDeskCatalogItem(db, item.id)).toBeNull();
  });

  it('keeps the request and its approvals when its item is deleted', async () => {
    const item = await createDeskCatalogItem(db, {
      generateId,
      name: 'Short lived',
      ticketTypeId: 'ttyp_ok',
      approvalSteps: [{ approverType: 'member', approverId: 'user_a' }],
    });
    await seedConversation('dconv_keep', 9001);
    await startDeskCatalogRequest(db, { generateId, conversationId: 'dconv_keep', item, actorType: 'agent', actorId: 'user_b' });
    // An item deleted before deleting was refused for pending requests.
    await db.delete(schema.deskCatalogItems).where(eq(schema.deskCatalogItems.id, item.id));
    const request = await getDeskConversationRequest(db, 'dconv_keep');
    expect(request).toMatchObject({ item: null, approvalStatus: 'pending' });
    expect(request?.approvals).toHaveLength(1);
    const decided = await decideDeskRequestApproval(db, {
      generateId,
      conversationId: 'dconv_keep',
      userId: 'user_a',
      canManage: false,
      decision: 'approved',
    });
    expect(decided.fulfilmentDue).toBe(true);
    expect(decided.changes[0]?.message.metadata).toMatchObject({ catalogItemName: null });
  });

  it('refuses to delete an item while requests made from it wait for approval', async () => {
    const item = await createDeskCatalogItem(db, {
      generateId,
      name: 'Wanted',
      ticketTypeId: 'ttyp_ok',
      approvalSteps: [{ approverType: 'member', approverId: 'user_a' }],
    });
    for (const [id, number] of [['dconv_wait_1', 9101], ['dconv_wait_2', 9102]] as const) {
      await seedConversation(id, number);
      await startDeskCatalogRequest(db, { generateId, conversationId: id, item, actorType: 'agent' });
    }
    const refused = deleteDeskCatalogItem(db, item.id);
    await expect(refused).rejects.toBeInstanceOf(DeskCatalogItemInUseError);
    await expect(refused).rejects.toMatchObject({ reason: 'has_pending_requests', count: 2, itemId: item.id });
    expect(await getDeskCatalogItem(db, item.id)).not.toBeNull();

    // One decided: one still waits.
    const decide = (conversationId: string, decision: 'approved' | 'rejected') =>
      decideDeskRequestApproval(db, { generateId, conversationId, userId: 'user_a', canManage: false, decision });
    await decide('dconv_wait_1', 'rejected');
    await expect(deleteDeskCatalogItem(db, item.id)).rejects.toMatchObject({ count: 1 });
    // All decided: the item can go, and the decided requests keep pointing at it.
    await decide('dconv_wait_2', 'approved');
    expect((await deleteDeskCatalogItem(db, item.id))?.id).toBe(item.id);
    expect((await conversationOf('dconv_wait_2')).catalogItemId).toBe(item.id);
  });
});

describe('a failure between statements', () => {
  const member = (approverId: string) => ({ approverType: 'member' as const, approverId });
  let item: Awaited<ReturnType<typeof createDeskCatalogItem>>;
  let single: Awaited<ReturnType<typeof createDeskCatalogItem>>;
  let number = 9600;

  beforeAll(async () => {
    item = await createDeskCatalogItem(db, {
      generateId,
      name: 'Three steps',
      ticketTypeId: 'ttyp_ok',
      approvalSteps: [member('user_a'), member('user_b'), member('user_a')],
    });
    single = await createDeskCatalogItem(db, { generateId, name: 'One step', ticketTypeId: 'ttyp_ok', approvalSteps: [member('user_a')] });
  });

  const fresh = async () => {
    number += 1;
    const id = `dconv_atomic_${number}`;
    await seedConversation(id, number);
    return id;
  };
  const start = (handle: Database, conversationId: string, of = item) =>
    startDeskCatalogRequest(handle, { generateId, conversationId, item: of, actorType: 'agent', actorId: 'user_b' });
  const decide = (handle: Database, conversationId: string, decision: 'approved' | 'rejected') =>
    decideDeskRequestApproval(handle, { generateId, conversationId, userId: 'user_a', canManage: false, decision });
  const state = async (id: string) => ({
    request: await conversationOf(id),
    steps: (await stepsOf(id)).map((step) => step.status),
  });

  /** How many writes a clean run of `work` makes. */
  async function writesOf(work: (handle: Database) => Promise<unknown>): Promise<number> {
    const counting = failingOn(Number.POSITIVE_INFINITY);
    await work(counting.db);
    return counting.writes();
  }

  it('never leaves a started request without its steps', async () => {
    const counted = await fresh();
    const total = await writesOf((handle) => start(handle, counted));
    expect(total).toBeGreaterThanOrEqual(2);
    const seen = new Set<string>();
    for (let nth = 1; nth <= total; nth++) {
      const id = await fresh();
      await expect(start(failingOn(nth).db, id)).rejects.toThrow(`statement ${nth} failed`);
      const { request, steps } = await state(id);
      if (request.catalogItemId === null) {
        // Nothing happened: it is still an ordinary ticket, and can be started.
        expect(request.approvalStatus).toBeNull();
        expect(steps).toEqual([]);
        seen.add('untouched');
        expect((await start(db, id)).pendingApproval?.stepIndex).toBe(0);
      } else {
        // Claimed, with every step: the first one can be decided.
        expect(request).toMatchObject({ catalogItemId: item.id, approvalStatus: 'pending' });
        expect(steps).toEqual(['pending', 'waiting', 'waiting']);
        seen.add('started');
        expect((await decide(db, id, 'approved')).nextApproval?.stepIndex).toBe(1);
      }
    }
    // A failure at the claim leaves nothing, one after it (the timeline entry) a whole request.
    expect([...seen].sort()).toEqual(['started', 'untouched']);
  });

  it.each([
    ['approved', ['approved', 'pending', 'waiting'], 'pending'],
    ['rejected', ['rejected', 'skipped', 'skipped'], 'rejected'],
  ] as const)('never leaves a step %s half way', async (decision, after, status) => {
    const counted = await fresh();
    await start(db, counted);
    const total = await writesOf((handle) => decide(handle, counted, decision));
    expect(total).toBeGreaterThanOrEqual(2);
    const seen = new Set<string>();
    for (let nth = 1; nth <= total; nth++) {
      const id = await fresh();
      await start(db, id);
      await expect(decide(failingOn(nth).db, id, decision)).rejects.toThrow(`statement ${nth} failed`);
      const { request, steps } = await state(id);
      if (steps[0] === 'pending') {
        expect(steps).toEqual(['pending', 'waiting', 'waiting']);
        expect(request.approvalStatus).toBe('pending');
        seen.add('untouched');
        // The approver can still decide it.
        expect((await decide(db, id, decision)).decided.status).toBe(decision);
      } else {
        expect(steps).toEqual(after);
        expect(request.approvalStatus).toBe(status);
        seen.add('decided');
        await expect(decide(db, id, decision)).rejects.toMatchObject({ reason: decision === 'approved' ? 'not_approver' : 'not_pending' });
      }
    }
    expect([...seen].sort()).toEqual(['decided', 'untouched']);
  });

  it('never leaves the last approval without the approved request', async () => {
    const counted = await fresh();
    await start(db, counted, single);
    const total = await writesOf((handle) => decide(handle, counted, 'approved'));
    for (let nth = 1; nth <= total; nth++) {
      const id = await fresh();
      await start(db, id, single);
      await expect(decide(failingOn(nth).db, id, 'approved')).rejects.toThrow(`statement ${nth} failed`);
      const { request, steps } = await state(id);
      expect([steps[0], request.approvalStatus]).toEqual(steps[0] === 'pending' ? ['pending', 'pending'] : ['approved', 'approved']);
    }
  });

  it('lets one of two starts and one of two decisions at the same moment win', async () => {
    const id = await fresh();
    const starts = await Promise.allSettled([start(db, id), start(db, id)]);
    expect(starts.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(starts.find((result) => result.status === 'rejected')).toMatchObject({ reason: { reason: 'already_request' } });
    expect((await state(id)).steps).toEqual(['pending', 'waiting', 'waiting']);
    expect(await eventsOf(id, 'approval_requested')).toHaveLength(1);

    const decisions = await Promise.allSettled([decide(db, id, 'approved'), decide(db, id, 'rejected')]);
    expect(decisions.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(decisions.find((result) => result.status === 'rejected')).toMatchObject({ reason: { reason: 'not_pending' } });
    const { request, steps } = await state(id);
    expect([
      [['approved', 'pending', 'waiting'], 'pending'],
      [['rejected', 'skipped', 'skipped'], 'rejected'],
    ]).toContainEqual([steps, request.approvalStatus]);

    // The second step belongs to someone else.
    if (request.approvalStatus === 'pending') {
      await expect(decide(db, id, 'approved')).rejects.toMatchObject({ reason: 'not_approver' });
    }
  });
});

describe('the help-center request', () => {
  it('shows an item to readers of its audience companies and starts a request from it', async () => {
    const open = await createDeskCatalogItem(db, { generateId, name: 'Open item', ticketTypeId: 'ttyp_ok', category: 'B' });
    const acme = await createDeskCatalogItem(db, {
      generateId,
      name: 'Acme item',
      ticketTypeId: 'ttyp_ok',
      category: 'A',
      audienceCompanyIds: ['co_1'],
    });
    const anonymous = await listDeskCatalogForPrincipal(db, { visitorId: 'dvis_x', verifiedEmail: null });
    expect(anonymous.map((i) => i.id)).toContain(open.id);
    expect(anonymous.map((i) => i.id)).not.toContain(acme.id);
    const pat = await listDeskCatalogForPrincipal(db, { visitorId: 'dvis_pat', verifiedEmail: 'pat@acme.test' });
    const ids = pat.map((i) => i.id);
    expect(ids.indexOf(acme.id)).toBeLessThan(ids.indexOf(open.id));
    expect(pat.find((i) => i.id === acme.id)?.form).toMatchObject({ id: 'ttyp_ok', titleLabel: 'Subject' });

    const created = await createDeskCatalogPortalRequest(db, {
      generateId,
      visitor: { id: 'dvis_pat', name: 'Pat', email: null, verifiedEmail: 'pat@acme.test' },
      item: open,
      description: 'Please',
    });
    expect(created.conversation).toMatchObject({ channel: 'portal', title: 'Open item', catalogItemId: open.id, approvalStatus: null });
    expect(created.fulfilmentDue).toBe(true);
    expect(created.pendingApproval).toBeNull();
  });

  it('refuses to start a request twice', async () => {
    const item = await createDeskCatalogItem(db, { generateId, name: 'Once', ticketTypeId: 'ttyp_ok' });
    await seedConversation('dconv_twice', 9500);
    await startDeskCatalogRequest(db, { generateId, conversationId: 'dconv_twice', item, actorType: 'agent' });
    await expect(startDeskCatalogRequest(db, { generateId, conversationId: 'dconv_twice', item, actorType: 'agent' })).rejects.toBeInstanceOf(
      DeskCatalogRefusedError,
    );
  });
});

describe('fulfilDeskCatalogRequest', () => {
  const item = {
    fulfilmentTasks: [
      { id: 't1', title: 'First', assigneeId: 'user_b', dueInDays: 1 },
      { id: 't2', title: 'Second', description: 'Do it' },
    ],
  };

  it("creates the tasks for the template or the conversation's owner, links them and does it once", async () => {
    await seedConversation('dconv_fulfil', 9003, { assigneeId: 'user_a' });
    const first = await fulfilDeskCatalogRequest(ctx, { db, conversation: { id: 'dconv_fulfil', assigneeId: 'user_a' }, item, actorUserId: 'user_b' });
    expect(first?.taskIds).toHaveLength(2);
    const tasks = (await tasksOf('dconv_fulfil')).sort((a, b) => a.title.localeCompare(b.title));
    expect(tasks.map((t) => [t.title, t.assigneeId, t.description])).toEqual([
      ['First', 'user_b', null],
      ['Second', 'user_a', 'Do it'],
    ]);
    expect(tasks[0]!.dueDate).not.toBeNull();
    expect(tasks[1]!.dueDate).toBeNull();
    // Each assignee hears about their task, as for any WeldFlow task.
    expect(notifications.assigned.mock.calls.map(([p]) => [p.assigneeId, p.taskTitle]).sort()).toEqual([
      ['user_a', 'Second'],
      ['user_b', 'First'],
    ]);

    expect(first?.created).toBe(2);
    const again = await fulfilDeskCatalogRequest(ctx, { db, conversation: { id: 'dconv_fulfil', assigneeId: 'user_a' }, item });
    expect(again).toBeNull();
    expect(await tasksOf('dconv_fulfil')).toHaveLength(2);
  });

  it('is completed by a second run after a failure at any point, without a task twice', async () => {
    // Two templates share a title: each still gets its own task.
    const templates = { fulfilmentTasks: [...item.fulfilmentTasks, { id: 't3', title: 'Second' }, { id: 't4', title: 'Third' }] };
    const titles = ['First', 'Second', 'Second', 'Third'];
    await seedConversation('dconv_retry_0', 9700);
    const counting = failingOn(Number.POSITIVE_INFINITY);
    await runDeskCatalogFulfilment(ctx, { db: counting.db, conversation: { id: 'dconv_retry_0', assigneeId: null }, item: templates });
    const total = counting.writes();
    expect(total).toBeGreaterThan(templates.fulfilmentTasks.length);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const partial = new Set<number>();
      for (let nth = 1; nth <= total; nth++) {
        const id = `dconv_retry_${nth}`;
        await seedConversation(id, 9700 + nth);
        const conversation = { id, assigneeId: null };
        // The run after the response fails, quietly, and leaves what it got to.
        expect(await fulfilDeskCatalogRequest(ctx, { db: failingOn(nth).db, conversation, item: templates })).toBeNull();
        const before = await tasksOf(id);
        const started = (await eventsOf(id, 'fulfilment_started')).length === 1;
        partial.add(started ? templates.fulfilmentTasks.length : before.length);

        const retried = await runDeskCatalogFulfilment(ctx, { db, conversation, item: templates, actorUserId: 'user_a' });
        // It created only what was missing (nothing at all when only the timeline entry's follow-up failed).
        expect(retried).toEqual(started ? null : { taskIds: expect.any(Array), created: titles.length - before.length });
        const after = await tasksOf(id);
        expect(after.map((task) => task.title).sort()).toEqual(titles);
        const [event] = await eventsOf(id, 'fulfilment_started');
        expect(await eventsOf(id, 'fulfilment_started')).toHaveLength(1);
        expect([...(event?.metadata?.taskIds as string[])].sort()).toEqual(after.map((task) => task.id).sort());
        if (retried) {
          // In the item's order, the tasks of the first run included.
          const byId = new Map(after.map((task) => [task.id, task.title]));
          expect(retried.taskIds.map((taskId) => byId.get(taskId))).toEqual(titles);
        }
      }
      // The failures really covered runs that stopped with none, some and all of the tasks.
      expect([...partial].sort()).toEqual([0, 1, 2, 3, 4]);
    } finally {
      spy.mockRestore();
    }
  });

  it('creates each task once and one timeline entry when two runs overlap', async () => {
    // The retry route while the run after an approval is still going, or two retries at once.
    await seedConversation('dconv_overlap', 9800, { assigneeId: 'user_a' });
    notifications.assigned.mockClear();
    const input = { db, conversation: { id: 'dconv_overlap', assigneeId: 'user_a' }, item, actorUserId: 'user_b' };
    const runs = await Promise.all([runDeskCatalogFulfilment(ctx, input), runDeskCatalogFulfilment(ctx, input)]);

    const tasks = await tasksOf('dconv_overlap');
    expect(tasks.map((task) => task.title).sort()).toEqual(['First', 'Second']);
    expect(tasks.map((task) => task.id).sort()).toEqual(
      [await deskFulfilmentTaskId('dconv_overlap', 't1'), await deskFulfilmentTaskId('dconv_overlap', 't2')].sort(),
    );
    const events = await eventsOf('dconv_overlap', 'fulfilment_started');
    expect(events.map((event) => event.id)).toEqual([await deskFulfilmentEventId('dconv_overlap')]);
    // Between them the runs made each task once, and each assignee heard once.
    expect(runs.reduce((sum, run) => sum + (run?.created ?? 0), 0)).toBe(2);
    expect(notifications.assigned).toHaveBeenCalledTimes(2);
  });

  it('does not make a task that is there under its id, even with another title', async () => {
    await seedConversation('dconv_named', 9801);
    await db.insert(schema.tasks).values({
      id: await deskFulfilmentTaskId('dconv_named', 't1'),
      title: 'Renamed since',
      sourceType: 'desk_conversation',
      sourceId: 'dconv_named',
    });
    notifications.assigned.mockClear();
    const run = await runDeskCatalogFulfilment(ctx, { db, conversation: { id: 'dconv_named', assigneeId: null }, item });
    expect(run?.created).toBe(1);
    expect((await tasksOf('dconv_named')).map((task) => task.title).sort()).toEqual(['Renamed since', 'Second']);
    // Nobody is told about the task that was there.
    expect(notifications.assigned).not.toHaveBeenCalled();
  });

  it('derives the ids from the conversation and the template, the same on both backends', async () => {
    // The Rust backend computes the same values (rust/crates/desk-domain/src/fulfilment.rs).
    expect(await deskFulfilmentTaskId('dconv_1', 't1')).toBe('task_e6d07bdcfd072cf4374b');
    expect(await deskFulfilmentEventId('dconv_1')).toBe('dmsg_a17d1f4acfa5004cb385');
  });

  it('leaves an item without tasks alone and never throws', async () => {
    await seedConversation('dconv_none', 9004);
    expect(await fulfilDeskCatalogRequest(ctx, { db, conversation: { id: 'dconv_none', assigneeId: null }, item: { fulfilmentTasks: [] } })).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const missing = await fulfilDeskCatalogRequest(ctx, { db, conversation: { id: 'dconv_missing', assigneeId: null }, item });
      expect(missing).toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('notifyDeskApprover', () => {
  const conversation = { id: 'dconv_note', name: 'Casey', email: null, title: 'Laptop', conversationNumber: 9005 };

  it('notifies the approver of the step and nobody when it has none', async () => {
    await seedConversation('dconv_note', 9005, { name: 'Casey', title: 'Laptop' });
    notifications.notify.mockClear();
    await notifyDeskApprover(ctx, { db, approval: { approverId: null, stepName: 'Budget', stepIndex: 0 }, conversation, item: { name: 'Laptop' } });
    expect(notifications.notify).not.toHaveBeenCalled();

    await notifyDeskApprover(ctx, { db, approval: { approverId: 'user_a', stepName: 'Budget', stepIndex: 0 }, conversation, item: { name: 'Laptop' } });
    expect(notifications.notify.mock.calls.map(([p]) => [p.userId, p.title, p.actionUrl])).toEqual([
      ['user_a', 'Approval needed: Laptop for Casey', '/welddesk/inbox/dconv_note'],
    ]);
  });

  it('never throws when the notification fails', async () => {
    notifications.notify.mockRejectedValueOnce(new Error('realtime down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        notifyDeskApprover(ctx, { db, approval: { approverId: 'user_a', stepName: null, stepIndex: 0 }, conversation, item: null }),
      ).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
