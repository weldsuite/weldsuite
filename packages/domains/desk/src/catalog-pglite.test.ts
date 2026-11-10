/**
 * The service catalogue's shared pieces on pglite: the db lib (items, the
 * reader view with audiences, a help-center request, starting and deciding,
 * deleting an item that has requests) and the domain follow-up (fulfilment
 * tasks linked to the conversation, once; the approver notification). The
 * lib is `@weldsuite/db/lib/desk-catalog`; it lives here because the db
 * package has no pglite.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createDeskCatalogItem,
  createDeskCatalogPortalRequest,
  decideDeskRequestApproval,
  deleteDeskCatalogItem,
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

const { fulfilDeskCatalogRequest, notifyDeskApprover } = await import('./catalog');
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
    await deleteDeskCatalogItem(db, item.id);
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

    const again = await fulfilDeskCatalogRequest(ctx, { db, conversation: { id: 'dconv_fulfil', assigneeId: 'user_a' }, item });
    expect(again).toBeNull();
    expect(await tasksOf('dconv_fulfil')).toHaveLength(2);
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
