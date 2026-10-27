/**
 * DB-backed integration tests for /api/chat-entity-channels (record chats):
 * the company and person providers, following (on create, on post, on
 * @mention, explicitly), the `channel_new` pushes, and the list + summary
 * endpoints with their permission and deleted-record filtering.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
import { chatEntityChannelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  getEntityProvider,
  listRecordChatProviders,
} from '../../services/chat/entity-channels';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

interface PublishedEvent {
  topic: string;
  event: string;
  data: Record<string, unknown>;
}

/** A REALTIME binding that records what was published instead of sending it. */
function realtimeStub() {
  const events: PublishedEvent[] = [];
  const binding = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Partial<PublishedEvent>;
      if (body.event && body.topic) events.push(body as PublishedEvent);
      return new Response('{}', { status: 200 });
    },
  };
  return {
    binding: binding as unknown as Fetcher,
    /** Users who got a `channel_new` push for this channel. */
    channelNewFor: (channelId: string) =>
      events
        .filter((e) => e.event === 'channel_new' && e.data.channelId === channelId)
        .map((e) => e.topic.replace('chat.user.', ''))
        .sort(),
  };
}

function api(userId: string, perms: string[], realtime = realtimeStub()) {
  const { request } = createTestApp('/api/chat-entity-channels', chatEntityChannelsRoutes, {
    context: { userId, permissions: permissions(...perms), tenantDb: db },
    env: { REALTIME: realtime.binding },
  });
  const json = (path: string, method: string, body?: unknown) =>
    request(`/api/chat-entity-channels${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { request, json, realtime };
}

const CRM = ['channels:read', 'messages:create', 'companies:read', 'companies:scope:all', 'people:read', 'people:scope:all'];

async function seedMember(
  userId: string,
  opts: { role?: string; memberType?: string; name?: string } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(schema.workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@example.com`,
    name: opts.name ?? userId,
    role: opts.role ?? 'MEMBER',
    memberType: opts.memberType ?? 'INTERNAL',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}

async function seedCompany(
  name: string,
  opts: { ownerId?: string; accountManagerId?: string } = {},
): Promise<string> {
  const id = generateId('cmp');
  const now = new Date();
  await db.insert(schema.companies).values({
    id,
    name,
    displayName: name,
    ownerId: opts.ownerId ?? null,
    accountManagerId: opts.accountManagerId ?? null,
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof schema.companies.$inferInsert);
  return id;
}

async function seedPerson(firstName: string, opts: { ownerId?: string } = {}): Promise<string> {
  const id = generateId('per');
  const now = new Date();
  await db.insert(schema.people).values({
    id,
    firstName,
    lastName: 'Test',
    fullName: `${firstName} Test`,
    displayName: `${firstName} Test`,
    ownerId: opts.ownerId ?? null,
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof schema.people.$inferInsert);
  return id;
}

interface FollowerSeed {
  userId: string;
  lastReadAt?: Date | null;
  isMuted?: boolean;
  unreadMentionCount?: number;
}

/** A record chat written straight to the DB, for the list tests. */
async function seedChat(
  entityType: string,
  entityId: string,
  opts: { lastMessageAt: Date | null; followers: FollowerSeed[]; name?: string },
): Promise<string> {
  const id = generateId('ch');
  const name = opts.name ?? `${entityType} ${entityId}`;
  await db.insert(schema.chatChannels).values({
    id,
    name,
    slug: `${id}-slug`,
    type: 'entity',
    entityType,
    entityId,
    entityDisplayName: name,
    lastMessageAt: opts.lastMessageAt,
    memberCount: opts.followers.length,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  for (const f of opts.followers) {
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'),
      channelId: id,
      userId: f.userId,
      lastReadAt: f.lastReadAt ?? null,
      isMuted: f.isMuted ?? false,
      unreadMentionCount: f.unreadMentionCount ?? 0,
    });
  }
  return id;
}

async function followerIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.chatChannelMembers.userId })
    .from(schema.chatChannelMembers)
    .where(eq(schema.chatChannelMembers.channelId, channelId));
  return rows.map((r) => r.userId).sort();
}

async function memberCount(channelId: string): Promise<number> {
  const [row] = await db
    .select({ memberCount: schema.chatChannels.memberCount })
    .from(schema.chatChannels)
    .where(eq(schema.chatChannels.id, channelId));
  return row?.memberCount ?? -1;
}

describe('record chat providers', () => {
  it('registers company and person with their CRM read permissions, in group order', () => {
    expect(getEntityProvider('company')?.requiredPermission).toBe('companies:read');
    expect(getEntityProvider('person')?.requiredPermission).toBe('people:read');
    expect(getEntityProvider('task')?.requiredPermission).toBe('tasks:read');
    expect(getEntityProvider('project')?.requiredPermission).toBe('projects:read');
    expect(getEntityProvider('domain')?.requiredPermission).toBe('domains:read');
    expect(getEntityProvider('sheet')?.requiredPermission).toBe('sheets:read');
    expect(getEntityProvider('doc')?.requiredPermission).toBe('docs:read');
    expect(listRecordChatProviders().map((p) => p.type)).toEqual(['company', 'person', 'task', 'project', 'domain', 'sheet', 'doc']);
  });

  it('keeps the legacy contact name readable but out of the record chat lists', () => {
    const contact = getEntityProvider('contact');
    expect(contact?.legacy).toBe(true);
    expect(contact?.requiredPermission).toBe('people:read');
    expect(getEntityProvider('customer')).toBeUndefined();
  });
});

describe('POST /:entityType/:entityId/messages · company and person', () => {
  it('creates a company chat followed by owner, account manager and poster, logs CRM activity and pushes channel_new', async () => {
    await seedMember('u_co_owner');
    // An admin: they see every company, so being the account manager makes them follow.
    await seedMember('u_co_am', { role: 'OWNER' });
    await seedMember('u_co_poster', { name: 'Poster' });
    const companyId = await seedCompany('Acme Rockets', { ownerId: 'u_co_owner', accountManagerId: 'u_co_am' });
    const { json, realtime } = api('u_co_poster', CRM);

    const res = await json(`/company/${companyId}/messages`, 'POST', { content: 'Renewal is due next month' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { channel: { id: string; name: string; entityType: string }; createdChannel: boolean } };
    expect(data.createdChannel).toBe(true);
    expect(data.channel.entityType).toBe('company');
    expect(data.channel.name).toBe('Acme Rockets');

    expect(await followerIds(data.channel.id)).toEqual(['u_co_am', 'u_co_owner', 'u_co_poster']);
    expect(await memberCount(data.channel.id)).toBe(3);
    const [poster] = await db
      .select({ role: schema.chatChannelMembers.role })
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, data.channel.id), eq(schema.chatChannelMembers.userId, 'u_co_poster')));
    expect(poster?.role).toBe('owner');

    const activities = await db
      .select()
      .from(schema.crmActivities)
      .where(eq(schema.crmActivities.customerId, companyId));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.subject).toBe('Renewal is due next month');

    expect(realtime.channelNewFor(data.channel.id)).toEqual(['u_co_am', 'u_co_owner', 'u_co_poster']);
  });

  it('leaves a default member who may not open the record out of the followers, and sends them no push', async () => {
    await seedMember('u_dm_owner');
    // A plain member who is not the owner: outside the company's owner scope.
    await seedMember('u_dm_am');
    await seedMember('u_dm_poster');
    const companyId = await seedCompany('Scoped Rockets', { ownerId: 'u_dm_owner', accountManagerId: 'u_dm_am' });
    const { json, realtime } = api('u_dm_poster', CRM);

    const res = await json(`/company/${companyId}/messages`, 'POST', { content: 'Pricing sent' });
    expect(res.status).toBe(201);
    const channelId = ((await res.json()) as { data: { channel: { id: string } } }).data.channel.id;
    expect(await followerIds(channelId)).toEqual(['u_dm_owner', 'u_dm_poster']);
    expect(await memberCount(channelId)).toBe(2);
    expect(realtime.channelNewFor(channelId)).toEqual(['u_dm_owner', 'u_dm_poster']);

    // The same rule applies when a deleted chat is revived.
    await db.update(schema.chatChannels).set({ deletedAt: new Date() }).where(eq(schema.chatChannels.id, channelId));
    await db.delete(schema.chatChannelMembers).where(eq(schema.chatChannelMembers.channelId, channelId));
    const revived = await api('u_dm_poster', CRM).json(`/company/${companyId}/follow`, 'POST');
    expect(revived.status).toBe(200);
    expect(await followerIds(channelId)).toEqual(['u_dm_owner', 'u_dm_poster']);
  });

  it('creates a person chat and logs the message on the person', async () => {
    await seedMember('u_pe_owner');
    await seedMember('u_pe_poster');
    const personId = await seedPerson('Jane', { ownerId: 'u_pe_owner' });
    const { json, realtime } = api('u_pe_poster', CRM);

    const res = await json(`/person/${personId}/messages`, 'POST', { content: 'Met Jane at the fair' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { channel: { id: string; name: string } } };
    expect(data.channel.name).toBe('Jane Test');
    expect(await followerIds(data.channel.id)).toEqual(['u_pe_owner', 'u_pe_poster']);

    const activities = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.personId, personId));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      type: 'comment',
      subject: 'Met Jane at the fair',
      status: 'completed',
      personId,
      assignedToId: 'u_pe_poster',
    });
    expect(activities[0]!.customerId).toBeNull();
    expect(realtime.channelNewFor(data.channel.id)).toEqual(['u_pe_owner', 'u_pe_poster']);
  });

  it('makes a colleague who posts in an existing chat follow it', async () => {
    await seedMember('u_late_owner');
    await seedMember('u_late_colleague');
    const companyId = await seedCompany('Late Corp', { ownerId: 'u_late_owner' });
    const first = await api('u_late_owner', CRM).json(`/company/${companyId}/messages`, 'POST', { content: 'hello' });
    const channelId = ((await first.json()) as { data: { channel: { id: string } } }).data.channel.id;

    const colleague = api('u_late_colleague', CRM);
    const res = await colleague.json(`/company/${companyId}/messages`, 'POST', { content: 'me too' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { createdChannel: boolean } }).data.createdChannel).toBe(false);
    expect(await followerIds(channelId)).toEqual(['u_late_colleague', 'u_late_owner']);
    expect(await memberCount(channelId)).toBe(2);
    expect(colleague.realtime.channelNewFor(channelId)).toEqual(['u_late_colleague']);
  });

  it('makes an @mentioned user follow when they may see the record, and nobody else', async () => {
    await seedMember('u_mn_poster');
    await seedMember('u_mn_admin', { role: 'OWNER' });
    await seedMember('u_mn_employee', { memberType: 'EMPLOYEE' });
    const companyId = await seedCompany('Mention Ltd', { ownerId: 'u_mn_poster' });
    const { json, realtime } = api('u_mn_poster', CRM);

    const res = await json(`/company/${companyId}/messages`, 'POST', {
      content: 'Can <@u_mn_admin> and <@u_mn_employee> take a look?',
    });
    expect(res.status).toBe(201);
    const channelId = ((await res.json()) as { data: { channel: { id: string } } }).data.channel.id;

    expect(await followerIds(channelId)).toEqual(['u_mn_admin', 'u_mn_poster']);
    expect(realtime.channelNewFor(channelId)).toEqual(['u_mn_admin', 'u_mn_poster']);
    const [admin] = await db
      .select({ unreadMentionCount: schema.chatChannelMembers.unreadMentionCount })
      .from(schema.chatChannelMembers)
      .where(and(eq(schema.chatChannelMembers.channelId, channelId), eq(schema.chatChannelMembers.userId, 'u_mn_admin')));
    expect(admin?.unreadMentionCount).toBe(1);
  });

  it('refuses callers without the record permission or outside its owner scope', async () => {
    await seedMember('u_sc_owner');
    await seedMember('u_sc_other');
    const companyId = await seedCompany('Scoped BV', { ownerId: 'u_sc_owner' });

    const noCrm = await api('u_sc_other', ['channels:read', 'messages:create']).json(
      `/company/${companyId}/messages`, 'POST', { content: 'x' },
    );
    expect(noCrm.status).toBe(403);

    const ownOnly = ['channels:read', 'messages:create', 'companies:read'];
    expect((await api('u_sc_other', ownOnly).request(`/api/chat-entity-channels/company/${companyId}/channel`)).status).toBe(403);
    const owner = await api('u_sc_owner', ownOnly).request(`/api/chat-entity-channels/company/${companyId}/channel`);
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { data: unknown }).data).toBeNull();
  });

  it('refuses a deleted company and an unknown type', async () => {
    const companyId = await seedCompany('Gone Inc');
    await db.update(schema.companies).set({ deletedAt: new Date() }).where(eq(schema.companies.id, companyId));
    const { json } = api('u_any', CRM);
    expect((await json(`/company/${companyId}/messages`, 'POST', { content: 'x' })).status).toBe(403);
    expect((await json(`/customer/${companyId}/messages`, 'POST', { content: 'x' })).status).toBe(400);
  });
});

describe('task and project visibility', () => {
  const allows = (perms: string[]) => async (p: string) => perms.includes(p);
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    const now = new Date();
    projectId = generateId('prj');
    taskId = generateId('tsk');
    await db.insert(schema.projects).values({ id: projectId, name: 'Launch', projectManagerId: 'u_tp_pm', createdAt: now, updatedAt: now });
    await db.insert(schema.projectMembers).values([
      { id: generateId('pm'), projectId, userId: 'u_tp_member', role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
      // Removed from the project: flow-api only deactivates the row.
      { id: generateId('pm'), projectId, userId: 'u_tp_removed', role: 'member', isActive: false, deletedAt: now, createdAt: now, updatedAt: now, joinedAt: now },
    ]);
    await db.insert(schema.tasks).values({ id: taskId, title: 'Ship it', projectId, createdAt: now, updatedAt: now } as typeof schema.tasks.$inferInsert);
  });

  const sees = (type: string, entityId: () => string, userId: string, perms: string[] = []) =>
    getEntityProvider(type)!.canAccess({ db, actingUserId: userId, entityId: entityId(), can: allows(perms) });

  it('opens a project task to its active members, not to someone removed from the project', async () => {
    expect(await sees('task', () => taskId, 'u_tp_member')).toBe(true);
    expect(await sees('task', () => taskId, 'u_tp_removed')).toBe(false);
    expect(await sees('project', () => projectId, 'u_tp_removed')).toBe(false);
  });

  it('opens every live project and its tasks with projects:scope:all, as WeldFlow does', async () => {
    expect(await sees('project', () => projectId, 'u_tp_admin')).toBe(false);
    expect(await sees('task', () => taskId, 'u_tp_admin')).toBe(false);
    expect(await sees('project', () => projectId, 'u_tp_admin', ['projects:scope:all'])).toBe(true);
    expect(await sees('task', () => taskId, 'u_tp_admin', ['projects:scope:all'])).toBe(true);
    expect(await sees('project', () => projectId, 'u_tp_pm')).toBe(true);
  });

  it('opens a project task to the project manager without a member row', async () => {
    expect(await sees('task', () => taskId, 'u_tp_pm')).toBe(true);
  });

  it('follows the project, not the task, for a project task: involved people removed from the project are out', async () => {
    const now = new Date();
    const watchedId = generateId('tsk');
    await db.insert(schema.tasks).values({
      id: watchedId,
      title: 'Watched',
      projectId,
      assigneeId: 'u_tp_removed',
      reporterId: 'u_tp_removed',
      assigneeIds: ['u_tp_removed'],
      watchers: ['u_tp_removed'],
      createdAt: now,
      updatedAt: now,
    } as typeof schema.tasks.$inferInsert);
    expect(await sees('task', () => watchedId, 'u_tp_removed')).toBe(false);
    expect(await sees('task', () => watchedId, 'u_tp_member')).toBe(true);
  });

  it('closes the tasks of a soft-deleted project to everyone, scope:all and the manager included', async () => {
    const now = new Date();
    const deletedProjectId = generateId('prj');
    const deletedTaskId = generateId('tsk');
    await db.insert(schema.projects).values({
      id: deletedProjectId,
      name: 'Gone',
      projectManagerId: 'u_tp_pm',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectMembers).values({
      id: generateId('pm'), projectId: deletedProjectId, userId: 'u_tp_member', role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: deletedTaskId, title: 'Orphaned', projectId: deletedProjectId, assigneeId: 'u_tp_member', createdAt: now, updatedAt: now,
    } as typeof schema.tasks.$inferInsert);
    expect(await sees('task', () => deletedTaskId, 'u_tp_member')).toBe(false);
    expect(await sees('task', () => deletedTaskId, 'u_tp_pm')).toBe(false);
    expect(await sees('task', () => deletedTaskId, 'u_tp_admin', ['projects:scope:all'])).toBe(false);
  });

  it('opens a task without a project to the people involved in it only', async () => {
    const now = new Date();
    const personalId = generateId('tsk');
    await db.insert(schema.tasks).values({
      id: personalId, title: 'Personal', assigneeId: 'u_tp_assignee', watchers: ['u_tp_watcher'], createdAt: now, updatedAt: now,
    } as typeof schema.tasks.$inferInsert);
    expect(await sees('task', () => personalId, 'u_tp_assignee')).toBe(true);
    expect(await sees('task', () => personalId, 'u_tp_watcher')).toBe(true);
    expect(await sees('task', () => personalId, 'u_tp_member')).toBe(false);
  });
});

describe('POST / DELETE /:entityType/:entityId/follow', () => {
  it('follow creates the chat when nobody has written yet, with its default followers', async () => {
    await seedMember('u_fl_owner');
    await seedMember('u_fl_me');
    const personId = await seedPerson('Follow', { ownerId: 'u_fl_owner' });
    const { json, realtime } = api('u_fl_me', CRM);

    const res = await json(`/person/${personId}/follow`, 'POST');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { channel: { id: string; lastMessageAt: string | null }; following: boolean; createdChannel: boolean } };
    expect(data.following).toBe(true);
    expect(data.createdChannel).toBe(true);
    expect(data.channel.lastMessageAt).toBeNull();
    expect(await followerIds(data.channel.id)).toEqual(['u_fl_me', 'u_fl_owner']);
    expect(realtime.channelNewFor(data.channel.id)).toEqual(['u_fl_me', 'u_fl_owner']);

    // Following again is a no-op: no duplicate row, no second push.
    const again = api('u_fl_me', CRM);
    expect((await again.json(`/person/${personId}/follow`, 'POST')).status).toBe(200);
    expect(await memberCount(data.channel.id)).toBe(2);
    expect(again.realtime.channelNewFor(data.channel.id)).toEqual([]);
  });

  it('follow joins an existing chat; unfollow leaves it and keeps the chat', async () => {
    await seedMember('u_uf_owner');
    await seedMember('u_uf_me');
    const companyId = await seedCompany('Unfollow Co', { ownerId: 'u_uf_owner' });
    const first = await api('u_uf_owner', CRM).json(`/company/${companyId}/messages`, 'POST', { content: 'hi' });
    const channelId = ((await first.json()) as { data: { channel: { id: string } } }).data.channel.id;

    const events = vi.mocked(publishEntityEvent);
    const channelEvents = () =>
      events.mock.calls
        .map(([e]) => e as { entityType: string; action: string; entityId: string })
        .filter((e) => e.entityType === 'chat_channel' && e.entityId === channelId)
        .map((e) => e.action);

    const me = api('u_uf_me', CRM);
    expect((await me.json(`/company/${companyId}/follow`, 'POST')).status).toBe(200);
    expect(await followerIds(channelId)).toEqual(['u_uf_me', 'u_uf_owner']);
    expect(me.realtime.channelNewFor(channelId)).toEqual(['u_uf_me']);
    expect(channelEvents()).toEqual(['created', 'joined']);

    expect((await me.json(`/company/${companyId}/follow`, 'DELETE')).status).toBe(204);
    expect(await followerIds(channelId)).toEqual(['u_uf_owner']);
    expect(await memberCount(channelId)).toBe(1);
    expect(channelEvents()).toEqual(['created', 'joined', 'left']);
    // Not following (any more) and no chat at all are both a quiet 204.
    expect((await me.json(`/company/${companyId}/follow`, 'DELETE')).status).toBe(204);
    expect((await me.json(`/company/${await seedCompany('No Chat')}/follow`, 'DELETE')).status).toBe(204);
    expect((await me.json(`/customer/${companyId}/follow`, 'DELETE')).status).toBe(400);
  });

  it('follow refuses a record the caller may not see', async () => {
    await seedMember('u_fr_owner');
    const companyId = await seedCompany('Private Co', { ownerId: 'u_fr_owner' });
    const res = await api('u_fr_other', ['channels:read', 'companies:read']).json(`/company/${companyId}/follow`, 'POST');
    expect(res.status).toBe(403);
  });
});

describe('GET / and GET /summary · record chat lists', () => {
  // A caller who sees only the companies and people they own (no scope:all).
  const ME = 'u_list_me';
  const MY_PERMS = ['channels:read', 'companies:read', 'people:read'];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const at = (iso: string) => new Date(iso);
    const mine = async (name: string) => seedCompany(name, { ownerId: ME });
    ids.coNewest = await seedChat('company', await mine('Newest'), {
      lastMessageAt: at('2026-10-20T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: at('2026-10-19T00:00:00Z'), unreadMentionCount: 2 }],
      name: 'Newest',
    });
    ids.coMiddle = await seedChat('company', await mine('Middle'), {
      lastMessageAt: at('2026-10-15T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: at('2026-10-16T00:00:00Z') }],
      name: 'Middle',
    });
    ids.coMuted = await seedChat('company', await mine('Muted'), {
      lastMessageAt: at('2026-10-10T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: null, isMuted: true }],
      name: 'Muted',
    });
    ids.coOldest = await seedChat('company', await mine('Oldest'), {
      lastMessageAt: at('2026-10-01T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: null }],
      name: 'Oldest',
    });
    // Same activity time as Middle: the id breaks the tie.
    ids.coTie = await seedChat('company', await mine('Tie'), {
      lastMessageAt: at('2026-10-15T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: at('2026-10-16T00:00:00Z') }],
      name: 'Tie',
    });
    // Mine, but not followed: only in `all`.
    ids.coNotFollowed = await seedChat('company', await mine('Not Followed'), {
      lastMessageAt: at('2026-10-18T10:00:00Z'),
      followers: [{ userId: 'u_someone_else' }],
      name: 'Not Followed',
    });
    // Followed, but someone else's company: out of my scope.
    ids.coOutOfScope = await seedChat('company', await seedCompany('Theirs', { ownerId: 'u_someone_else' }), {
      lastMessageAt: at('2026-10-21T10:00:00Z'),
      followers: [{ userId: ME }],
      name: 'Theirs',
    });
    // Followed, but the company was deleted since.
    const deletedCompany = await mine('Deleted');
    ids.coDeleted = await seedChat('company', deletedCompany, {
      lastMessageAt: at('2026-10-22T10:00:00Z'),
      followers: [{ userId: ME }],
      name: 'Deleted',
    });
    await db.update(schema.companies).set({ deletedAt: new Date() }).where(eq(schema.companies.id, deletedCompany));
    // A person chat I follow.
    ids.person = await seedChat('person', await seedPerson('Listed', { ownerId: ME }), {
      lastMessageAt: at('2026-10-12T10:00:00Z'),
      followers: [{ userId: ME, lastReadAt: null, unreadMentionCount: 1 }],
      name: 'Listed Test',
    });
  });

  const list = async (query: string, perms = MY_PERMS) => {
    const res = await api(ME, perms).request(`/api/chat-entity-channels${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      data: Array<{ id: string; isFollowing: boolean; isMuted: boolean; lastReadAt: string | null; unreadMentionCount: number }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
  };

  it('lists followed chats, most recent first, without deleted or out-of-scope records', async () => {
    const body = await list('?type=company');
    const [middleOrTieFirst, middleOrTieSecond] = [ids.coMiddle, ids.coTie].sort().reverse();
    expect(body.data.map((r) => r.id)).toEqual([ids.coNewest, middleOrTieFirst, middleOrTieSecond, ids.coMuted, ids.coOldest]);
    expect(body.pagination.hasMore).toBe(false);
    expect(body.data[0]).toMatchObject({ isFollowing: true, isMuted: false, unreadMentionCount: 2 });
    expect(body.data[0]?.lastReadAt).toBe('2026-10-19T00:00:00.000Z');
  });

  it('pages with the cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await list(`?type=company&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...body.data.map((r) => r.id));
      cursor = body.pagination.hasMore ? body.pagination.cursor : null;
      pages++;
    } while (cursor && pages < 10);
    const all = await list('?type=company');
    expect(seen).toEqual(all.data.map((r) => r.id));
    expect(pages).toBe(3);
  });

  it('filters unread (not muted), mentions and all', async () => {
    const unread = await list('?type=company&filter=unread');
    expect(unread.data.map((r) => r.id)).toEqual([ids.coNewest, ids.coOldest]);

    const mentions = await list('?filter=mentions');
    expect(mentions.data.map((r) => r.id)).toEqual([ids.coNewest, ids.person]);

    const all = await list('?type=company&filter=all');
    expect(all.data.map((r) => r.id)).toContain(ids.coNotFollowed);
    expect(all.data.find((r) => r.id === ids.coNotFollowed)?.isFollowing).toBe(false);
    expect(all.data.map((r) => r.id)).not.toContain(ids.coOutOfScope);
    expect(all.data.map((r) => r.id)).not.toContain(ids.coDeleted);
  });

  it('searches by record name', async () => {
    const body = await list('?type=company&search=mid');
    expect(body.data.map((r) => r.id)).toEqual([ids.coMiddle]);
  });

  it('leaves out the types the caller has no permission for', async () => {
    const companiesOnly = ['channels:read', 'companies:read'];
    const body = await list('?filter=following', companiesOnly);
    expect(body.data.map((r) => r.id)).not.toContain(ids.person);
    const persons = await list('?type=person', companiesOnly);
    expect(persons.data).toEqual([]);
    expect(persons.pagination.totalCount).toBe(0);
  });

  it('refuses unknown and legacy types', async () => {
    expect((await api(ME, MY_PERMS).request('/api/chat-entity-channels?type=customer')).status).toBe(400);
    expect((await api(ME, MY_PERMS).request('/api/chat-entity-channels?type=contact')).status).toBe(400);
  });

  it('summarises followed, unread and mention counts per type', async () => {
    const res = await api(ME, MY_PERMS).request('/api/chat-entity-channels/summary');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ type: string; followed: number; unread: number; mentions: number }> };
    // No tasks:read / projects:read / domains:read: those groups are left out.
    expect(data.map((s) => s.type)).toEqual(['company', 'person']);
    expect(data[0]).toMatchObject({ type: 'company', followed: 5, unread: 2, mentions: 2 });
    expect(data[1]).toMatchObject({ type: 'person', followed: 1, unread: 1, mentions: 1 });
  });
});

describe('PATCH /:entityType/mute — sidebar "Mute all" / "Unmute all"', () => {
  const ME = 'u_mute_me';
  const MUTE_PERMS = [...CRM, 'channels:update'];

  it('mutes every followed company chat, leaves other types, other users and already-muted rows alone', async () => {
    const chatA = await seedChat('company', await seedCompany('Mute A', { ownerId: ME }), {
      lastMessageAt: new Date('2026-10-01T00:00:00Z'),
      followers: [{ userId: ME }],
    });
    // Already muted: the bulk UPDATE should not touch (or re-publish for) it.
    const chatB = await seedChat('company', await seedCompany('Mute B', { ownerId: ME }), {
      lastMessageAt: new Date('2026-10-02T00:00:00Z'),
      followers: [{ userId: ME, isMuted: true }],
    });
    // Another type: a `company` mute-all must leave it alone.
    const personChat = await seedChat('person', await seedPerson('Mute Other', { ownerId: ME }), {
      lastMessageAt: new Date('2026-10-03T00:00:00Z'),
      followers: [{ userId: ME }],
    });
    // Another user's membership on the same channel: must stay unmuted.
    await db.insert(schema.chatChannelMembers).values({
      id: generateId('cmb'),
      channelId: chatA,
      userId: 'u_mute_colleague',
      isMuted: false,
    });

    const events = vi.mocked(publishEntityEvent);
    events.mockClear();

    const res = await api(ME, MUTE_PERMS).json('/company/mute', 'PATCH', { isMuted: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { updated: number } }).data.updated).toBe(1);

    const isMutedOf = async (channelId: string, userId: string) => {
      const [row] = await db
        .select({ isMuted: schema.chatChannelMembers.isMuted })
        .from(schema.chatChannelMembers)
        .where(and(eq(schema.chatChannelMembers.channelId, channelId), eq(schema.chatChannelMembers.userId, userId)));
      return row?.isMuted;
    };
    expect(await isMutedOf(chatA, ME)).toBe(true);
    expect(await isMutedOf(chatA, 'u_mute_colleague')).toBe(false);
    expect(await isMutedOf(personChat, ME)).toBe(false);

    const updatedEvents = events.mock.calls
      .map(([e]) => e as { entityType: string; action: string; entityId: string })
      .filter((e) => e.entityType === 'chat_channel' && e.action === 'updated');
    expect(updatedEvents.map((e) => e.entityId)).toEqual([chatA]);

    // Unmuting flips both (A from the mute above, B from the original seed);
    // a second identical call has nothing left to change.
    const unmuted = await api(ME, MUTE_PERMS).json('/company/mute', 'PATCH', { isMuted: false });
    expect(((await unmuted.json()) as { data: { updated: number } }).data.updated).toBe(2);
    expect(await isMutedOf(chatA, ME)).toBe(false);
    expect(await isMutedOf(chatB, ME)).toBe(false);
    const again = await api(ME, MUTE_PERMS).json('/company/mute', 'PATCH', { isMuted: false });
    expect(((await again.json()) as { data: { updated: number } }).data.updated).toBe(0);
  });

  it('refuses without channels:update, without the record type permission, and an unknown or legacy type', async () => {
    const noUpdate = ['channels:read', 'messages:create', 'companies:read'];
    expect((await api('u_mute_a', noUpdate).json('/company/mute', 'PATCH', { isMuted: true })).status).toBe(403);

    const noCompanyPerm = ['channels:read', 'channels:update', 'messages:create'];
    expect((await api('u_mute_b', noCompanyPerm).json('/company/mute', 'PATCH', { isMuted: true })).status).toBe(403);

    expect((await api('u_mute_c', MUTE_PERMS).json('/customer/mute', 'PATCH', { isMuted: true })).status).toBe(400);
    expect((await api('u_mute_c', MUTE_PERMS).json('/contact/mute', 'PATCH', { isMuted: true })).status).toBe(400);
  });
});
