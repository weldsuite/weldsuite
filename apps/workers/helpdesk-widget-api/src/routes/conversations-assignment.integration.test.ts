/**
 * Auto-assignment on a visitor message, through the whole worker on pglite.
 *
 * A message into an open conversation nobody owns hands it to a teammate from
 * `helpdesk_settings.automation.deskAssignment` (mode, roster, away list, cap),
 * in the background: the conversation gets its assignee, a system `assigned`
 * event (`metadata.auto`) goes on the timeline, the hub gets a
 * `desk_conversation:assigned` event and realtime hears it. The worker has no
 * `WORKFLOW_WORKER` binding here, so the pick is the local one: balanced
 * (fewest open conversations; ties go to the lowest user id), whatever the
 * mode says.
 *
 * Every scenario writes into a conversation the team is already waiting on, so
 * the only background work is the assignment itself: no notification goes out
 * (the notifications of a new conversation, and of one reopened, have their
 * own tests). The two that do notify end up with the assignee as the one
 * recipient.
 *
 * Conformance-ready: seeds have fixed ids and times; the harness records and
 * compares the realtime and entity-event side effects of both backends.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { WIDGET, addWidget, at, get, json, member, seedWorkspaces, widgetEnv } from '../test/widget-fixtures';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskMessages, helpdeskSettings, notifications, workspaceMembers } = tenantSchema;

const BASE = '/api/conversations';
const ROSTER = ['user_ann', 'user_bob', 'user_cy'];
const AVATAR = (name: string) => `https://img.widget.test/${name}.png`;

let tenantDb: Database;
let masterDb: Database;

function app() {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: '/public/helpdesk-widget',
  });
}

const call = (path: string, init?: RequestInit) => app().request(path, init);

interface Roster {
  mode: 'off' | 'round_robin' | 'balanced';
  memberIds: string[];
  awayMemberIds?: string[];
  maxOpenPerMember?: number | null;
}

let sequence = 1000;

/**
 * Put the workspace in a known state: the assignment settings (none for no
 * row), and the open conversations each teammate already has. Conversations
 * of earlier scenarios are closed so they count for nobody.
 */
async function arrange(roster: Roster | null, loads: Record<string, number> = {}) {
  await tenantDb
    .update(deskConversations)
    .set({ state: 'closed' })
    .where(inArray(deskConversations.visitorId, ['vis_assign', 'vis_assign_new']));
  await tenantDb.delete(deskConversations).where(like(deskConversations.id, 'dconv_load_%'));
  await tenantDb.delete(helpdeskSettings);
  if (roster) {
    await tenantDb.insert(helpdeskSettings).values({
      id: 'hds_assignment',
      createdAt: at(0),
      updatedAt: at(0),
      automation: {
        enabled: false,
        deskAssignment: {
          mode: roster.mode,
          memberIds: roster.memberIds,
          awayMemberIds: roster.awayMemberIds ?? [],
          maxOpenPerMember: roster.maxOpenPerMember ?? null,
        },
      },
    });
  }
  for (const [userId, count] of Object.entries(loads)) {
    for (let n = 1; n <= count; n++) {
      await tenantDb.insert(deskConversations).values({
        id: `dconv_load_${userId}_${n}`,
        conversationNumber: ++sequence,
        visitorId: 'vis_load',
        state: 'open',
        assigneeId: userId,
        createdAt: at(0),
        updatedAt: at(0),
      });
    }
  }
}

/** An open conversation of `vis_assign` the team has yet to answer, with nobody on it. */
async function waiting(id: string, values: Partial<typeof deskConversations.$inferInsert> = {}) {
  await tenantDb.insert(deskConversations).values({
    id,
    conversationNumber: ++sequence,
    visitorId: 'vis_assign',
    name: 'Alex',
    title: id,
    state: 'open',
    channel: 'messenger',
    assigneeId: null,
    waitingSince: at(1),
    createdAt: at(0),
    updatedAt: at(0),
    lastMessageAt: at(1),
    lastMessagePreview: 'Hi',
    ...values,
  });
}

async function visitorWrites(id: string, visitorId = 'vis_assign') {
  const res = await call(`${BASE}/${id}/messages`, json({ visitorId, body: 'Hello again' }));
  expect(res.status).toBe(201);
  return res;
}

const assignedEvents = async (conversationId: string) =>
  (
    await tenantDb
      .select()
      .from(deskMessages)
      .where(and(eq(deskMessages.conversationId, conversationId), eq(deskMessages.kind, 'event')))
  ).filter((m: { metadata: { eventType?: string } | null }) => m.metadata?.eventType === 'assigned');

const assigneeOf = async (id: string): Promise<string | null> => {
  const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id));
  return row!.assigneeId;
};

/** The background assignment landed: the conversation has its assignee and its event. */
async function assignedTo(id: string, userId: string) {
  const events = await vi.waitFor(
    async () => {
      const found = await assignedEvents(id);
      expect(found).toHaveLength(1);
      return found;
    },
    { timeout: 10_000, interval: 25 },
  );
  expect(await assigneeOf(id)).toBe(userId);
  expect(events[0]).toMatchObject({
    kind: 'event',
    body: null,
    authorType: 'system',
    authorId: null,
    attachments: null,
    metadata: { eventType: 'assigned', assigneeId: userId, auto: true },
  });
  return events[0];
}

/** Time for background work that is expected to change nothing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function stillUnassigned(id: string) {
  await settle();
  expect(await assigneeOf(id)).toBeNull();
  expect(await assignedEvents(id)).toEqual([]);
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);

  await tenantDb.insert(workspaceMembers).values([
    member('user_ann', { name: 'Ann Agent', picture: AVATAR('ann') }),
    member('user_bob', { name: 'Bob Builder', role: 'ADMIN' }),
    member('user_cy', { name: 'Cy Support', picture: AVATAR('cy') }),
    // On the roster but not eligible: a guest, one who has not accepted, one removed.
    member('user_dee', { name: 'Dee Guest', memberType: 'EXTERNAL_GUEST' }),
    member('user_eve', { name: 'Eve Pending', status: 'PENDING' }),
    member('user_gus', { name: 'Gus Gone', deletedAt: at(1) }),
  ]);
}, 120_000);

describe('auto-assignment: when it does nothing', () => {
  it('leaves a conversation alone when the workspace has no assignment settings', async () => {
    await arrange(null);
    await waiting('dconv_a_none');
    await visitorWrites('dconv_a_none');
    await stillUnassigned('dconv_a_none');
  });

  it('leaves a conversation alone when the mode is off, however long the roster', async () => {
    await arrange({ mode: 'off', memberIds: ROSTER });
    await waiting('dconv_a_off');
    await visitorWrites('dconv_a_off');
    await stillUnassigned('dconv_a_off');
  });

  it('leaves a conversation alone when nobody on the roster can take it', async () => {
    // A guest, a member who has not accepted, a removed member: no candidates.
    await arrange({ mode: 'balanced', memberIds: ['user_dee', 'user_eve', 'user_gus'] });
    await waiting('dconv_a_nobody');
    await visitorWrites('dconv_a_nobody');
    await stillUnassigned('dconv_a_nobody');

    await arrange({ mode: 'balanced', memberIds: [] });
    await waiting('dconv_a_empty');
    await visitorWrites('dconv_a_empty');
    await stillUnassigned('dconv_a_empty');
  });

  it('leaves a conversation alone when everyone on the roster is at the cap', async () => {
    await arrange(
      { mode: 'balanced', memberIds: ROSTER, maxOpenPerMember: 1 },
      { user_ann: 1, user_bob: 1, user_cy: 1 },
    );
    await waiting('dconv_a_capped');
    await visitorWrites('dconv_a_capped');
    await stillUnassigned('dconv_a_capped');
  });

  it('does not take a conversation somebody already has', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER });
    await waiting('dconv_a_owned', { assigneeId: 'user_bob' });
    await visitorWrites('dconv_a_owned');
    await settle();
    expect(await assigneeOf('dconv_a_owned')).toBe('user_bob');
    expect(await assignedEvents('dconv_a_owned')).toEqual([]);
  });
});

describe('auto-assignment: who gets it', () => {
  it('round robin gives the first teammate in id order when nobody has any load', async () => {
    await arrange({ mode: 'round_robin', memberIds: ROSTER });
    await waiting('dconv_a_rr');
    await visitorWrites('dconv_a_rr');
    await assignedTo('dconv_a_rr', 'user_ann');
  });

  it('balanced gives the teammate with the fewest open conversations', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER }, { user_ann: 2, user_bob: 1 });
    await waiting('dconv_a_bal');
    await visitorWrites('dconv_a_bal');
    await assignedTo('dconv_a_bal', 'user_cy');
  });

  it('balanced breaks a tie in id order', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER }, { user_ann: 1, user_bob: 1, user_cy: 1 });
    await waiting('dconv_a_tie');
    await visitorWrites('dconv_a_tie');
    await assignedTo('dconv_a_tie', 'user_ann');
  });

  it('picks locally without the workflow worker, so round robin counts load too', async () => {
    await arrange({ mode: 'round_robin', memberIds: ROSTER }, { user_ann: 2, user_bob: 1, user_cy: 1 });
    await waiting('dconv_a_rrload');
    await visitorWrites('dconv_a_rrload');
    await assignedTo('dconv_a_rrload', 'user_bob');
  });

  it('counts only open conversations towards the load', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER }, { user_bob: 1, user_cy: 1 });
    // Ann has plenty, all of them closed.
    for (let n = 1; n <= 3; n++) {
      await tenantDb.insert(deskConversations).values({
        id: `dconv_load_user_ann_${n}`,
        conversationNumber: ++sequence,
        visitorId: 'vis_load',
        state: 'closed',
        assigneeId: 'user_ann',
        createdAt: at(0),
        updatedAt: at(0),
      });
    }
    await waiting('dconv_a_closed_load');
    await visitorWrites('dconv_a_closed_load');
    await assignedTo('dconv_a_closed_load', 'user_ann');
  });

  it('skips teammates who set themselves away', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER, awayMemberIds: ['user_ann'] });
    await waiting('dconv_a_away');
    await visitorWrites('dconv_a_away');
    await assignedTo('dconv_a_away', 'user_bob');
  });

  it('skips roster members who are guests, pending or removed', async () => {
    await arrange({ mode: 'balanced', memberIds: ['user_dee', 'user_eve', 'user_gus', 'user_cy'] });
    await waiting('dconv_a_eligible');
    await visitorWrites('dconv_a_eligible');
    await assignedTo('dconv_a_eligible', 'user_cy');
  });

  it('gives the teammate under the cap when the others are full', async () => {
    await arrange(
      { mode: 'balanced', memberIds: ROSTER, maxOpenPerMember: 2 },
      { user_ann: 2, user_bob: 2, user_cy: 1 },
    );
    await waiting('dconv_a_cap');
    await visitorWrites('dconv_a_cap');
    await assignedTo('dconv_a_cap', 'user_cy');
  });
});

describe('auto-assignment: what it leaves behind', () => {
  it('shows the assignee and the assigned event to the visitor', async () => {
    await arrange({ mode: 'balanced', memberIds: ['user_ann'] });
    await waiting('dconv_a_visible');
    const res = await visitorWrites('dconv_a_visible');
    // The answer to the message is the conversation before the assignment.
    expect(((await res.json()) as { data: { conversation: { assignee: unknown } } }).data.conversation.assignee).toBeNull();
    await assignedTo('dconv_a_visible', 'user_ann');

    const thread = await call(`${BASE}/dconv_a_visible?visitorId=vis_assign`, get());
    expect(thread.status).toBe(200);
    const body = (await thread.json()) as {
      data: { conversation: { assignee: unknown; state: string }; messages: Array<Record<string, unknown>> };
    };
    expect(body.data.conversation).toMatchObject({ state: 'open', assignee: { name: 'Ann', avatar: AVATAR('ann') } });
    const events = body.data.messages.filter((m) => m.kind === 'event');
    expect(events).toEqual([
      expect.objectContaining({ authorType: 'system', eventType: 'assigned', body: null, authorName: null }),
    ]);

    // The listing carries the assignee too.
    const list = await call(`${BASE}?visitorId=vis_assign`, get());
    const found = ((await list.json()) as { data: Array<{ id: string; assignee: unknown }> }).data.find(
      (c) => c.id === 'dconv_a_visible',
    );
    expect(found!.assignee).toEqual({ name: 'Ann', avatar: AVATAR('ann') });
  });

  it('keeps the conversation waiting for the team: an assignment is not an answer', async () => {
    await arrange({ mode: 'balanced', memberIds: ['user_cy'] });
    await waiting('dconv_a_waiting');
    await visitorWrites('dconv_a_waiting');
    await assignedTo('dconv_a_waiting', 'user_cy');
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_a_waiting'));
    expect(row).toMatchObject({ state: 'open', lastMessagePreview: 'Hello again' });
    expect(row!.waitingSince).not.toBeNull();
    expect(row!.waitingSince).toEqual(row!.lastMessageAt);
  });

  it('assigns a conversation the visitor reopens, and tells the new assignee alone', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER }, { user_ann: 1 });
    await waiting('dconv_a_reopen', { state: 'closed', waitingSince: null });
    await visitorWrites('dconv_a_reopen');
    await assignedTo('dconv_a_reopen', 'user_bob');

    const [note] = await vi.waitFor(
      async () => {
        const rows = await tenantDb.select().from(notifications).where(eq(notifications.entityId, 'dconv_a_reopen'));
        expect(rows).toHaveLength(1);
        return rows;
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(note).toMatchObject({
      userId: 'user_bob',
      title: 'Alex replied',
      body: 'Hello again',
      actionUrl: '/welddesk/inbox/dconv_a_reopen',
    });
  });

  it('assigns a new conversation and tells the new assignee alone', async () => {
    await arrange({ mode: 'balanced', memberIds: ROSTER }, { user_ann: 1, user_bob: 1 });
    const res = await call(BASE, json({ visitorId: 'vis_assign_new', name: 'Nora', body: 'Hello, new here' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { conversation: { id: string; assignee: unknown } } };
    // The answer is the conversation as it was created.
    expect(data.conversation.assignee).toBeNull();
    const id = data.conversation.id;

    await assignedTo(id, 'user_cy');
    const [note] = await vi.waitFor(
      async () => {
        const rows = await tenantDb.select().from(notifications).where(eq(notifications.entityId, id));
        expect(rows).toHaveLength(1);
        return rows;
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(note).toMatchObject({
      userId: 'user_cy',
      title: 'New conversation from Nora',
      body: 'Hello, new here',
      actionUrl: `/welddesk/inbox/${id}`,
    });
  });
});
