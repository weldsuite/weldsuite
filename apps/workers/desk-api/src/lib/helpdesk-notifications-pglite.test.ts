/**
 * pglite-backed tests for the WeldDesk notification helpers
 * (`@weldsuite/notifications` helpers/helpdesk.ts) as desk-api uses them:
 * who is told, who is not (self-assignment, unassigned reply) and how the
 * workspace's `notifyOnAssignment` / `notifyOnCustomerReply` settings gate them.
 *
 * The helpers run the real orchestrator against pglite with an empty env, so
 * the `notifications` row is the observable outcome (realtime, email and push
 * are no-ops without their bindings).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  helpdeskPreview,
  isHelpdeskNotificationEnabled,
  sendTicketAssignedNotification,
  sendTicketReplyNotification,
  type NotificationEnv,
} from '@weldsuite/notifications';
import type { NotificationSettings } from '@weldsuite/db/schema/helpdesk-settings';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const WORKSPACE = 'org_test';
const env: NotificationEnv = {};

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.notifications);
  await db.delete(schema.helpdeskSettings);
  await db.delete(schema.workspaceMembers);
});

async function setNotificationSettings(notifications: Partial<NotificationSettings>) {
  await db.insert(schema.helpdeskSettings).values({
    id: generateId('hds'),
    notifications: {
      emailNotifications: true,
      pushNotifications: true,
      smsNotifications: false,
      notifyOnNewTicket: true,
      notifyOnAssignment: true,
      notifyOnStatusChange: true,
      notifyOnCustomerReply: true,
      notifyOnSLABreach: true,
      ...notifications,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function notificationsFor(userId: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
}

describe('helpdesk notification pure helpers', () => {
  it('treats a missing settings blob or key as enabled; only an explicit false disables', () => {
    expect(isHelpdeskNotificationEnabled(null, 'notifyOnAssignment')).toBe(true);
    expect(isHelpdeskNotificationEnabled(undefined, 'notifyOnCustomerReply')).toBe(true);
    expect(isHelpdeskNotificationEnabled({}, 'notifyOnAssignment')).toBe(true);
    expect(isHelpdeskNotificationEnabled({ notifyOnAssignment: false }, 'notifyOnAssignment')).toBe(false);
    expect(isHelpdeskNotificationEnabled({ notifyOnAssignment: false }, 'notifyOnCustomerReply')).toBe(true);
  });

  it('helpdeskPreview collapses whitespace and truncates with an ellipsis', () => {
    expect(helpdeskPreview('  hello \n\n  world\t!  ')).toBe('hello world !');
    expect(helpdeskPreview(null)).toBe('');
    const long = helpdeskPreview('a'.repeat(400));
    expect(long).toHaveLength(180);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('sendTicketAssignedNotification · pglite integration', () => {
  it('notifies the assignee, naming the assigner and linking the conversation', async () => {
    await db.insert(schema.workspaceMembers).values({ id: generateId('wm'), userId: 'user_alice', name: 'Alice' });

    const id = await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      assignedByUserId: 'user_alice',
      kind: 'conversation',
      entityId: 'dconv_1',
      subject: 'Printer is on fire',
    });

    expect(id).toBeTruthy();
    const [row] = await notificationsFor('user_bob');
    expect(row).toMatchObject({
      category: 'helpdesk',
      notificationType: 'ticket_assigned',
      entityType: 'desk_conversation',
      entityId: 'dconv_1',
      actionUrl: '/welddesk/inbox/dconv_1',
      actorType: 'user',
      actorId: 'user_alice',
    });
    expect(row.body).toBe('Alice assigned "Printer is on fire" to you');
  });

  it('points a ticket assignment at the ticket page', async () => {
    await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      assignedByUserId: 'user_alice',
      kind: 'ticket',
      entityId: 'tkt_1',
      subject: null,
      reference: 'TKT-1042',
    });
    const [row] = await notificationsFor('user_bob');
    expect(row.entityType).toBe('ticket');
    expect(row.actionUrl).toBe('/welddesk/tickets/tkt_1');
    expect(row.body).toContain('TKT-1042');
  });

  it('skips self-assignment', async () => {
    const id = await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_alice',
      assignedByUserId: 'user_alice',
      kind: 'conversation',
      entityId: 'dconv_1',
    });
    expect(id).toBeNull();
    expect(await notificationsFor('user_alice')).toHaveLength(0);
  });

  it('sends a system assignment (no assigner) to the assignee', async () => {
    await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      assignedByUserId: null,
      kind: 'conversation',
      entityId: 'dconv_1',
      subject: 'Refund please',
    });
    const [row] = await notificationsFor('user_bob');
    expect(row.actorType).toBe('system');
    expect(row.body).toBe('"Refund please" was assigned to you');
  });

  it('sends nothing when the workspace turned notifyOnAssignment off', async () => {
    await setNotificationSettings({ notifyOnAssignment: false });
    const id = await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      assignedByUserId: 'user_alice',
      kind: 'conversation',
      entityId: 'dconv_1',
    });
    expect(id).toBeNull();
    expect(await notificationsFor('user_bob')).toHaveLength(0);
  });

  it('still sends when only notifyOnCustomerReply is off', async () => {
    await setNotificationSettings({ notifyOnCustomerReply: false });
    const id = await sendTicketAssignedNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      assignedByUserId: 'user_alice',
      kind: 'conversation',
      entityId: 'dconv_1',
    });
    expect(id).toBeTruthy();
  });
});

describe('sendTicketReplyNotification · pglite integration', () => {
  it('notifies the assignee with the reply preview', async () => {
    const id = await sendTicketReplyNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      kind: 'conversation',
      entityId: 'dconv_2',
      customerName: 'Ada Lovelace',
      customerContactId: 'ppl_ada',
      messageBody: 'Thanks,\n\n  but it is   still broken',
      subject: 'Printer is on fire',
    });

    expect(id).toBeTruthy();
    const [row] = await notificationsFor('user_bob');
    expect(row).toMatchObject({
      category: 'helpdesk',
      notificationType: 'ticket_reply',
      title: 'Ada Lovelace replied',
      body: 'Thanks, but it is still broken',
      actionUrl: '/welddesk/inbox/dconv_2',
      actorType: 'contact',
      actorId: 'ppl_ada',
    });
  });

  it('falls back to the subject when the reply has no text', async () => {
    await sendTicketReplyNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      kind: 'conversation',
      entityId: 'dconv_2',
      customerName: 'ada@example.com',
      messageBody: '   ',
      subject: 'Printer is on fire',
    });
    const [row] = await notificationsFor('user_bob');
    expect(row.body).toBe('Printer is on fire');
    expect(row.actorType).toBe('system');
  });

  it('sends nothing for an unassigned conversation', async () => {
    const id = await sendTicketReplyNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: null,
      kind: 'conversation',
      entityId: 'dconv_2',
      customerName: 'Ada',
      messageBody: 'hello',
    });
    expect(id).toBeNull();
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
  });

  it('sends nothing when the workspace turned notifyOnCustomerReply off', async () => {
    await setNotificationSettings({ notifyOnCustomerReply: false });
    const id = await sendTicketReplyNotification({
      db,
      env,
      workspaceId: WORKSPACE,
      assigneeId: 'user_bob',
      kind: 'conversation',
      entityId: 'dconv_2',
      customerName: 'Ada',
      messageBody: 'hello',
    });
    expect(id).toBeNull();
    expect(await notificationsFor('user_bob')).toHaveLength(0);
  });
});
