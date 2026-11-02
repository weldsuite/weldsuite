/**
 * /api/team-members/user/:userId/* against a real pglite tenant DB: the
 * profile (self or admin edits), the viewer's private notes, what two members
 * have in common, and a member's activity feed.
 *
 * These run in the Rust conformance suite too ("core: team-members
 * (directory)"), so nothing here is mocked that the Rust server can't see.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { teamMembersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs each write twice, on a copy of the database for one.
vi.setConfig({ testTimeout: 60_000 });

let db: Database;

const at = (minute: number) => new Date(Date.UTC(2026, 1, 3, 14, minute, 0, 456));

const WORKING_HOURS = { monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' } };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    {
      id: 'wm_ann',
      userId: 'user_ann',
      email: 'ann@acme.test',
      name: 'Ann',
      role: 'ADMIN',
      status: 'ACTIVE',
      title: 'Head of Ops',
      hoursPerWeek: '40',
      links: [{ label: 'Site', url: 'https://ann.example' }],
      createdAt: at(1),
      updatedAt: at(1),
    },
    { id: 'wm_bob', userId: 'user_bob', email: 'bob@acme.test', name: 'Bob', role: 'MEMBER', status: 'ACTIVE', createdAt: at(2), updatedAt: at(2) },
    { id: 'wm_cy', userId: 'user_cy', email: 'cy@acme.test', name: 'Cy', role: 'MEMBER', status: 'ACTIVE', createdAt: at(3), updatedAt: at(3) },
    { id: 'wm_old', userId: 'user_old', email: 'old@acme.test', name: 'Old', role: 'MEMBER', status: 'ACTIVE', createdAt: at(4), updatedAt: at(4), deletedAt: at(5) },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.userPreferences).values({
    id: 'upref_ann',
    userId: 'user_ann',
    timezone: 'Europe/Amsterdam',
    workingHours: WORKING_HOURS,
    createdAt: at(1),
    updatedAt: at(1),
  } as typeof schema.userPreferences.$inferInsert);

  // What Bob and Cy share, and what they don't.
  await db.insert(schema.chatChannels).values([
    { id: 'ch_general', name: 'general', slug: 'general', type: 'public', memberCount: 3, lastMessageAt: at(10), createdAt: at(0), updatedAt: at(0) },
    { id: 'ch_dm', name: 'bob-cy', slug: 'bob-cy', type: 'dm', memberCount: 2, lastMessageAt: at(20), createdAt: at(0), updatedAt: at(0) },
    { id: 'ch_solo', name: 'solo', slug: 'solo', type: 'private', memberCount: 1, lastMessageAt: at(30), createdAt: at(0), updatedAt: at(0) },
    { id: 'ch_archived', name: 'old', slug: 'old', type: 'public', memberCount: 2, isArchived: true, lastMessageAt: at(40), createdAt: at(0), updatedAt: at(0) },
  ] as (typeof schema.chatChannels.$inferInsert)[]);
  await db.insert(schema.chatChannelMembers).values([
    { id: 'chm_1', channelId: 'ch_general', userId: 'user_bob' },
    { id: 'chm_2', channelId: 'ch_general', userId: 'user_cy' },
    { id: 'chm_3', channelId: 'ch_general', userId: 'user_ann' },
    { id: 'chm_4', channelId: 'ch_dm', userId: 'user_bob' },
    { id: 'chm_5', channelId: 'ch_dm', userId: 'user_cy' },
    { id: 'chm_6', channelId: 'ch_solo', userId: 'user_bob' },
    { id: 'chm_7', channelId: 'ch_archived', userId: 'user_bob' },
    { id: 'chm_8', channelId: 'ch_archived', userId: 'user_cy' },
  ] as (typeof schema.chatChannelMembers.$inferInsert)[]);
  await db.insert(schema.projects).values([
    { id: 'prj_shared', name: 'Launch', status: 'Active', color: '#ff0000', createdAt: at(0), updatedAt: at(11) },
    { id: 'prj_other', name: 'Solo', createdAt: at(0), updatedAt: at(12) },
    { id: 'prj_closed', name: 'Closed', isActive: false, createdAt: at(0), updatedAt: at(13) },
  ] as (typeof schema.projects.$inferInsert)[]);
  await db.insert(schema.projectMembers).values([
    { id: 'pm_1', projectId: 'prj_shared', userId: 'user_bob' },
    { id: 'pm_2', projectId: 'prj_shared', userId: 'user_cy' },
    { id: 'pm_3', projectId: 'prj_other', userId: 'user_bob' },
    { id: 'pm_4', projectId: 'prj_closed', userId: 'user_bob' },
    { id: 'pm_5', projectId: 'prj_closed', userId: 'user_cy' },
  ] as (typeof schema.projectMembers.$inferInsert)[]);
  await db.insert(schema.tasks).values([
    { id: 'tsk_delegated', title: 'Write brief', status: 'todo', assigneeId: 'user_bob', reporterId: 'user_cy', projectId: 'prj_shared', dueDate: at(50), createdAt: at(0), updatedAt: at(21) },
    { id: 'tsk_assignees', title: 'Pair on it', status: 'doing', assigneeId: 'user_cy', assigneeIds: ['user_bob', 'user_cy'], createdAt: at(0), updatedAt: at(22) },
    { id: 'tsk_watchers', title: 'Watch it', status: 'done', watchers: ['user_bob', 'user_cy'], createdAt: at(0), updatedAt: at(23) },
    { id: 'tsk_alone', title: 'Bob only', status: 'todo', assigneeId: 'user_bob', createdAt: at(0), updatedAt: at(24) },
  ] as (typeof schema.tasks.$inferInsert)[]);
  await db.insert(schema.crmOpportunities).values([
    { id: 'opp_shared', name: 'Big deal', customerId: 'cus_1', ownerId: 'user_bob', teamMembers: ['user_bob', 'user_cy'], createdAt: at(0), updatedAt: at(31) },
    { id: 'opp_solo', name: 'Small deal', customerId: 'cus_1', ownerId: 'user_bob', teamMembers: ['user_bob'], createdAt: at(0), updatedAt: at(32) },
  ] as (typeof schema.crmOpportunities.$inferInsert)[]);
  await db.insert(schema.crmActivities).values([
    { id: 'act_shared', type: 'meeting', subject: 'Kickoff', assignedToId: 'user_bob', attendees: ['user_cy', 'user_bob'], createdAt: at(0), updatedAt: at(33) },
  ] as (typeof schema.crmActivities.$inferInsert)[]);
  await db.insert(schema.helpdeskConversations).values([
    { id: 'hc_shared', conversationNumber: 'C-1', customerName: 'Acme', subject: 'Login broken', assigneeId: 'user_bob', createdAt: at(0), updatedAt: at(34) },
    { id: 'hc_solo', conversationNumber: 'C-2', customerName: 'Acme', subject: 'Invoice', assigneeId: 'user_cy', createdAt: at(0), updatedAt: at(35) },
  ] as (typeof schema.helpdeskConversations.$inferInsert)[]);
  await db.insert(schema.helpdeskConversationEvents).values([
    { id: 'hce_1', conversationId: 'hc_shared', eventType: 'assigned', actorId: 'user_cy', description: 'Cy assigned Bob' },
    { id: 'hce_2', conversationId: 'hc_shared', eventType: 'replied', actorId: 'user_bob', description: 'Bob replied' },
    { id: 'hce_3', conversationId: 'hc_solo', eventType: 'replied', actorId: 'user_cy', description: 'Cy replied' },
  ] as (typeof schema.helpdeskConversationEvents.$inferInsert)[]);

  await db.insert(schema.auditLogs).values([
    { id: 'al_1', entityType: 'ticket', entityId: 'tk_1', action: 'created', description: 'Created ticket', performedBy: 'user_bob', createdAt: at(1) },
    { id: 'al_2', entityType: 'ticket', entityId: 'tk_1', action: 'updated', description: 'Updated ticket', performedBy: 'user_bob', changes: { status: { from: 'open', to: 'closed' } }, createdAt: at(2) },
    { id: 'al_3', entityType: 'company', entityId: 'co_1', action: 'deleted', description: 'Deleted company', performedBy: 'user_bob', createdAt: at(3) },
    { id: 'al_4', entityType: 'company', entityId: 'co_2', action: 'created', description: 'By Cy', performedBy: 'user_cy', createdAt: at(4) },
  ] as (typeof schema.auditLogs.$inferInsert)[]);
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
}

/** No pre-resolved permissions: the routes resolve them from the member rows. */
function unresolved(userId: string) {
  return createTestApp('/api/team-members', teamMembersRoutes, { context: { tenantDb: db, userId } });
}

function send(t: ReturnType<typeof app>, method: string, path: string, body: unknown) {
  return t.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Data<T = Record<string, unknown>> = { data: T };

describe('GET /api/team-members/user/:userId/profile', () => {
  it('combines the member row with their preferences', async () => {
    const res = await app('user_bob', 'channels:read').request('/api/team-members/user/user_ann/profile');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Data).data).toEqual({
      id: 'wm_ann',
      userId: 'user_ann',
      name: 'Ann',
      email: 'ann@acme.test',
      picture: null,
      role: 'ADMIN',
      status: 'ACTIVE',
      title: 'Head of Ops',
      bio: null,
      phone: null,
      location: null,
      pronouns: null,
      links: [{ label: 'Site', url: 'https://ann.example' }],
      hoursPerWeek: '40.00',
      workingHours: WORKING_HOURS,
      timezone: 'Europe/Amsterdam',
      canEdit: false,
    });
  });

  it('lets the member and an admin edit, and defaults the timezone', async () => {
    const self = ((await (await app('user_cy', 'channels:read').request('/api/team-members/user/user_cy/profile')).json()) as Data).data;
    expect(self).toMatchObject({ canEdit: true, timezone: 'UTC', workingHours: null, hoursPerWeek: null });
    const admin = ((await (await app('user_ann', 'team:update').request('/api/team-members/user/user_cy/profile')).json()) as Data).data;
    expect(admin.canEdit).toBe(true);
  });

  it('resolves the viewer from the database when nothing is cached', async () => {
    const asAdmin = ((await (await unresolved('user_ann').request('/api/team-members/user/user_bob/profile')).json()) as Data).data;
    expect(asAdmin.canEdit).toBe(true);
    const asMember = ((await (await unresolved('user_cy').request('/api/team-members/user/user_bob/profile')).json()) as Data).data;
    expect(asMember.canEdit).toBe(false);
  });

  it('is a 404 for an unknown or removed member', async () => {
    for (const userId of ['user_nobody', 'user_old']) {
      expect((await app('user_ann', 'team:update').request(`/api/team-members/user/${userId}/profile`)).status).toBe(404);
    }
  });
});

describe('PATCH /api/team-members/user/:userId/profile', () => {
  it('updates the member and creates their preferences', async () => {
    const res = await send(app('user_cy', 'channels:read'), 'PATCH', '/api/team-members/user/user_cy/profile', {
      title: 'Engineer',
      bio: null,
      pronouns: 'they/them',
      links: [{ label: 'GitHub', url: 'https://github.com/cy', extra: 'dropped' }],
      hoursPerWeek: 37.5,
      timezone: 'Europe/London',
      workingHours: WORKING_HOURS,
      unknown: 'ignored',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Data).data).toMatchObject({
      title: 'Engineer',
      bio: null,
      pronouns: 'they/them',
      links: [{ label: 'GitHub', url: 'https://github.com/cy' }],
      hoursPerWeek: '37.50',
      timezone: 'Europe/London',
      workingHours: WORKING_HOURS,
      canEdit: true,
    });
    const [prefs] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, 'user_cy'));
    expect(prefs).toMatchObject({ timezone: 'Europe/London', theme: 'system' });
  });

  it("lets an admin edit someone else's profile, clearing fields", async () => {
    const res = await send(app('user_ann', 'team:update'), 'PATCH', '/api/team-members/user/user_bob/profile', {
      phone: '+31 6 1234 5678',
      hoursPerWeek: null,
      links: null,
      workingHours: null,
      timezone: '',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Data).data).toMatchObject({ phone: '+31 6 1234 5678', hoursPerWeek: null, links: null, timezone: 'UTC', workingHours: null });
  });

  it("updates an existing preferences row and leaves the member alone when only the timezone changes", async () => {
    const res = await send(app('user_ann', 'channels:read'), 'PATCH', '/api/team-members/user/user_ann/profile', {
      timezone: 'America/New_York',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Data).data).toMatchObject({ timezone: 'America/New_York', title: 'Head of Ops', workingHours: WORKING_HOURS });
  });

  it('accepts an empty patch', async () => {
    const res = await send(app('user_bob', 'channels:read'), 'PATCH', '/api/team-members/user/user_bob/profile', {});
    expect(res.status).toBe(200);
  });

  it("refuses someone else's profile without team:update", async () => {
    const res = await send(app('user_bob', 'team:read'), 'PATCH', '/api/team-members/user/user_ann/profile', { title: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const t = app('user_bob', 'channels:read');
    const path = '/api/team-members/user/user_bob/profile';
    const bad = await send(t, 'PATCH', path, {
      title: 'x'.repeat(121),
      links: [{ label: '', url: 'not a url' }, { label: 'ok', url: 'mailto:bob@acme.test' }],
      hoursPerWeek: 200,
      workingHours: 'always',
      timezone: null,
    });
    expect(bad.status).toBe(400);
    const tooMany = await send(t, 'PATCH', path, { links: Array.from({ length: 11 }, () => ({ label: 'a', url: 'https://a.test' })) });
    expect(tooMany.status).toBe(400);
    const wrongTypes = await send(t, 'PATCH', path, { bio: 5, hoursPerWeek: '40', links: 'x', phone: 'x'.repeat(41) });
    expect(wrongTypes.status).toBe(400);
    expect((await send(t, 'PATCH', path, '{bad')).status).toBe(400);
    expect((await send(t, 'PATCH', path, '[]')).status).toBe(400);
  });

  it('is a 404 for a member who is not there', async () => {
    const res = await send(app('user_ann', 'team:update'), 'PATCH', '/api/team-members/user/user_ghost/profile', { title: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('/api/team-members/user/:userId/notes', () => {
  it("keeps one private note per viewer and subject", async () => {
    const bob = app('user_bob', 'channels:read');
    const empty = await bob.request('/api/team-members/user/user_cy/notes');
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Data<unknown>).data).toBeNull();

    const created = await send(bob, 'PUT', '/api/team-members/user/user_cy/notes', { body: 'Likes tea' });
    expect(created.status).toBe(200);
    expect(((await created.json()) as Data).data).toMatchObject({ authorUserId: 'user_bob', subjectUserId: 'user_cy', body: 'Likes tea' });

    const updated = await send(bob, 'PUT', '/api/team-members/user/user_cy/notes', { body: '' });
    expect(((await updated.json()) as Data).data).toMatchObject({ body: '' });

    const read = ((await (await bob.request('/api/team-members/user/user_cy/notes')).json()) as Data).data;
    expect(read.body).toBe('');

    // Ann can't see Bob's note.
    const ann = await app('user_ann', 'team:update').request('/api/team-members/user/user_cy/notes');
    expect(((await ann.json()) as Data<unknown>).data).toBeNull();

    const removed = await bob.request('/api/team-members/user/user_cy/notes', { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const [row] = await db
      .select()
      .from(schema.memberNotes)
      .where(and(eq(schema.memberNotes.authorUserId, 'user_bob'), eq(schema.memberNotes.subjectUserId, 'user_cy')));
    expect(row).toBeUndefined();
    // Deleting again is fine.
    expect((await bob.request('/api/team-members/user/user_cy/notes', { method: 'DELETE' })).status).toBe(204);
  });

  it('validates the note', async () => {
    const t = app('user_bob', 'channels:read');
    expect((await send(t, 'PUT', '/api/team-members/user/user_cy/notes', { body: 'x'.repeat(20001) })).status).toBe(400);
    expect((await send(t, 'PUT', '/api/team-members/user/user_cy/notes', {})).status).toBe(400);
    expect((await send(t, 'PUT', '/api/team-members/user/user_cy/notes', { body: null })).status).toBe(400);
  });
});

describe('GET /api/team-members/user/:userId/common', () => {
  it('lists what two members share, per category', async () => {
    const res = await app('user_bob', 'channels:read').request('/api/team-members/user/user_cy/common');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Data).data).toEqual({
      channels: [
        { id: 'ch_dm', name: 'bob-cy', type: 'dm', memberCount: 2 },
        { id: 'ch_general', name: 'general', type: 'public', memberCount: 3 },
      ],
      projects: [{ id: 'prj_shared', name: 'Launch', status: 'Active', color: '#ff0000' }],
      tasks: [
        { id: 'tsk_watchers', title: 'Watch it', status: 'done', projectId: null, dueDate: null, role: 'shared_watcher' },
        { id: 'tsk_assignees', title: 'Pair on it', status: 'doing', projectId: null, dueDate: null, role: 'shared_assignee' },
        {
          id: 'tsk_delegated',
          title: 'Write brief',
          status: 'todo',
          projectId: 'prj_shared',
          dueDate: at(50).toISOString(),
          role: 'delegated',
        },
      ],
      crm: [
        { id: 'opp_shared', kind: 'opportunity', name: 'Big deal', status: 'open' },
        { id: 'act_shared', kind: 'activity', name: 'Kickoff', status: 'planned' },
      ],
      helpdesk: [{ id: 'hc_shared', kind: 'conversation', subject: 'Login broken', status: 'active' }],
    });
  });

  it('answers only the categories asked for', async () => {
    const t = app('user_cy', 'channels:read');
    const some = ((await (await t.request('/api/team-members/user/user_bob/common?categories=projects,crm,bogus')).json()) as Data<Record<string, unknown[]>>).data;
    expect(some.channels).toEqual([]);
    expect(some.projects).toHaveLength(1);
    expect(some.crm).toHaveLength(2);
    const none = ((await (await t.request('/api/team-members/user/user_bob/common?categories=,,')).json()) as Data<Record<string, unknown[]>>).data;
    // Only empty names: nothing is asked for.
    expect(none.channels).toEqual([]);
  });

  it('answers nothing in common with yourself', async () => {
    const res = await app('user_bob', 'channels:read').request('/api/team-members/user/user_bob/common');
    expect(((await res.json()) as Data).data).toEqual({ channels: [], projects: [], tasks: [], crm: [], helpdesk: [] });
  });
});

describe('GET /api/team-members/user/:userId/activity', () => {
  type ActivityBody = {
    data: Array<Record<string, unknown>>;
    pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
  };

  it("lists the member's audit trail, newest first", async () => {
    const res = await app('user_ann', 'team:read').request('/api/team-members/user/user_bob/activity');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivityBody;
    expect(body.data.map((a) => a.id)).toEqual(['al_3', 'al_2', 'al_1']);
    expect(body.data[1]).toEqual({
      id: 'al_2',
      action: 'updated',
      entityType: 'ticket',
      entityId: 'tk_1',
      description: 'Updated ticket',
      createdAt: at(2).toISOString(),
      changes: { status: { from: 'open', to: 'closed' } },
    });
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('pages with a cursor', async () => {
    const t = app('user_bob', 'channels:read');
    const first = (await (await t.request('/api/team-members/user/user_bob/activity?limit=2')).json()) as ActivityBody;
    expect(first.data.map((a) => a.id)).toEqual(['al_3', 'al_2']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'al_2' });
    const next = (await (await t.request('/api/team-members/user/user_bob/activity?limit=2&cursor=al_2')).json()) as ActivityBody;
    expect(next.data.map((a) => a.id)).toEqual(['al_1']);
    expect(next.pagination.totalCount).toBe(3);
    // An unknown cursor adds no keyset condition and counts every entry.
    const unknown = (await (await t.request('/api/team-members/user/user_bob/activity?cursor=al_nope')).json()) as ActivityBody;
    expect(unknown.data).toHaveLength(3);
    expect(unknown.pagination.totalCount).toBe(4);
  });

  it("refuses someone else's activity without team:read", async () => {
    expect((await app('user_cy', 'team:update').request('/api/team-members/user/user_bob/activity')).status).toBe(403);
    // The MEMBER tier carries team:read.
    expect((await unresolved('user_cy').request('/api/team-members/user/user_bob/activity')).status).toBe(200);
    expect((await unresolved('user_ann').request('/api/team-members/user/user_bob/activity')).status).toBe(200);
  });

  it('validates the query before checking access', async () => {
    const t = app('user_cy', 'channels:read');
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=2.5x']) {
      expect((await t.request(`/api/team-members/user/user_bob/activity?${query}`)).status).toBe(400);
    }
  });
});
