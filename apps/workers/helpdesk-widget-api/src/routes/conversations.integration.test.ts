/**
 * The visitor's conversation routes (/api/conversations) on pglite, refusals
 * included: identify a visitor, list their conversations, start one, read one
 * (public messages only), send a message (text and files from the bucket) and
 * rate a closed conversation.
 *
 * The visitor is the one the visitor token names (`Authorization: Bearer`,
 * from `POST /api/visitor`), never a field of the request: without a token a
 * route is a 401. Every route checks the conversation belongs to that visitor;
 * another visitor's conversation is a 404, never a 403. Visitors never see
 * notes or ticket-field changes. Tests that need a particular seeded visitor
 * sign its token as the route would (`visitorToken`); the others start a
 * session through the route.
 *
 * A visitor message tells the team in the background (`waitUntil`): in-app
 * notifications go to the assignee, or to every active internal teammate who
 * is not a viewer, and only when the ball moves to the team. The tests read
 * those rows once the work has landed. Auto-assignment has its own file.
 *
 * Conformance-ready: seeds have fixed ids and times, the bucket is an
 * R2-shaped memory bucket the harness shares with the Rust backend, and the
 * realtime and entity-event bindings are recorded by the harness and compared.
 * The routes validate with `@hono/zod-validator`, so a refused body answers
 * `{ success: false, error: { issues, name: 'ZodError' } }`: one issue each.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import {
  FILES_ORIGIN,
  ORG,
  WIDGET,
  addWidget,
  at,
  get,
  getAs,
  json,
  member,
  seedWorkspaces,
  startSession,
  visitorRow,
  visitorToken,
  widgetEnv,
  type VisitorSession,
} from '../test/widget-fixtures';

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

const { deskConversations, deskMessages, deskVisitors, notifications, workspaceMembers } = tenantSchema;

const BASE = '/api/conversations';
const ANN_FACE = 'https://img.widget.test/ann.png';
const MESSAGE_ID = /^dmsg_[0-9a-z]{12,}$/;
const CONVERSATION_ID = /^dconv_[0-9a-z]{12,}$/;

let tenantDb: Database;
let masterDb: Database;
// One bucket for the whole file: the harness serves each bucket to Rust once.
const storage = createMemoryR2();

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv({ STORAGE: storage, ...env }),
    rustBasePath: '/public/helpdesk-widget',
  });
}

const call = (path: string, init?: RequestInit, env?: Record<string, unknown>) => app(env).request(path, init);

/** The seeded visitors' tokens, by visitor id (signed in `beforeAll`). */
const tokens: Record<string, string> = {};
const tokenOf = (visitorId: string) => {
  const token = tokens[visitorId];
  if (!token) throw new Error(`no token for ${visitorId}`);
  return token;
};
/** A request as the seeded visitor `visitorId`. */
const as = (visitorId: string, body: unknown) => json(body, { token: tokenOf(visitorId) });
const session = () => startSession(call);

const read = (id: string, visitorId: string) => call(`${BASE}/${id}`, getAs(tokenOf(visitorId)));
const send = (id: string, visitorId: string, body: Record<string, unknown>, env?: Record<string, unknown>) =>
  call(`${BASE}/${id}/messages`, as(visitorId, body), env);
const rate = (id: string, visitorId: string, body: Record<string, unknown>) => call(`${BASE}/${id}/rating`, as(visitorId, body));

const notFound = (id: string) => ({
  success: false,
  error: { code: 'NOT_FOUND', message: `Conversation with ID '${id}' not found` },
});
const badRequest = (message: string) => ({ success: false, error: { code: 'BAD_REQUEST', message } });
const conflict = (message: string) => ({ success: false, error: { code: 'CONFLICT', message } });
const tokenRequired = { success: false, error: { code: 'VISITOR_TOKEN_REQUIRED', message: 'Missing visitor token' } };
const tokenInvalid = { success: false, error: { code: 'VISITOR_TOKEN_INVALID', message: 'Invalid visitor token' } };

/** The zod issue a refused body answers with, wrapped as `@hono/zod-validator` does. */
const zodRefusal = (...issues: Array<Record<string, unknown>>) => ({
  success: false,
  error: { issues, name: 'ZodError' },
});
const tooSmallString = (path: string[]) => ({
  code: 'too_small',
  minimum: 1,
  type: 'string',
  inclusive: true,
  exact: false,
  message: 'String must contain at least 1 character(s)',
  path,
});
const required = (path: string[]) => ({
  code: 'invalid_type',
  expected: 'string',
  received: 'undefined',
  path,
  message: 'Required',
});

/** The background work of a visitor message: wait for the rows it writes (`expected` of them). */
async function notificationsFor(entityId: string, expected: number) {
  return vi.waitFor(
    async () => {
      const rows = await tenantDb
        .select()
        .from(notifications)
        .where(eq(notifications.entityId, entityId))
        .orderBy(notifications.userId);
      expect(rows).toHaveLength(expected);
      return rows;
    },
    { timeout: 10_000, interval: 25 },
  );
}

/** Time for background work that is expected to write nothing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function seedConversation(
  id: string,
  conversationNumber: number,
  values: Partial<typeof deskConversations.$inferInsert> = {},
) {
  await tenantDb.insert(deskConversations).values({
    id,
    conversationNumber,
    visitorId: 'vis_writer',
    name: 'Wendy',
    email: 'wendy@example.test',
    title: id,
    state: 'open',
    channel: 'messenger',
    assigneeId: null,
    waitingSince: null,
    createdAt: at(0),
    updatedAt: at(0),
    lastMessageAt: at(1),
    lastMessagePreview: 'Seed',
    ...values,
  });
}

async function seedMessage(
  id: string,
  conversationId: string,
  second: number,
  values: Partial<typeof deskMessages.$inferInsert> = {},
) {
  await tenantDb.insert(deskMessages).values({
    id,
    conversationId,
    kind: 'message',
    authorType: 'visitor',
    authorId: 'vis_owner',
    body: id,
    createdAt: at(second),
    ...values,
  });
}

const PHOTO_URL = `${FILES_ORIGIN}/widgets/${ORG}/dconv_thread/1700000000000_att_abc123_photo.png`;

/** A conversation as the widget sees it, for a seed row. */
const publicConversation = (values: Record<string, unknown>) => ({
  id: expect.any(String),
  conversationNumber: expect.any(Number),
  title: null,
  state: 'open',
  createdAt: at(0).toISOString(),
  lastMessageAt: at(1).toISOString(),
  lastMessagePreview: 'Seed',
  lastMessageFromTeam: false,
  assignee: null,
  rating: null,
  ...values,
});

/** A public message with the nullable parts null. */
const publicMessage = (values: Record<string, unknown>) => ({
  id: expect.any(String),
  conversationId: expect.any(String),
  kind: 'message',
  body: null,
  authorType: 'visitor',
  authorName: null,
  authorAvatar: null,
  attachments: null,
  eventType: null,
  clientId: null,
  createdAt: expect.any(String),
  ...values,
});

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);

  // The visitors the seeded conversations belong to, and their tokens.
  const seeded = ['vis_owner', 'vis_writer', 'vis_other', 'vis_sort', 'vis_many', 'vis_attach', 'vis_nobody'];
  await tenantDb.insert(deskVisitors).values(seeded.map((id) => visitorRow(id)));
  for (const id of seeded) tokens[id] = await visitorToken(id);

  // Ann is the one teammate the team is told through: the others cannot be
  // notified (a viewer, a guest, a member who has not accepted).
  await tenantDb.insert(workspaceMembers).values([
    member('user_ann', { name: 'Ann Agent', picture: ANN_FACE }),
    member('user_viewer', { name: 'Vic Viewer', role: 'VIEWER' }),
    member('user_guest', { name: 'Gail Guest', memberType: 'EXTERNAL_GUEST' }),
    member('user_pending', { name: 'Pat Pending', status: 'PENDING' }),
  ]);

  // vis_owner's thread: every kind of timeline row.
  await seedConversation('dconv_thread', 1, {
    visitorId: 'vis_owner',
    name: 'Olivia',
    email: 'olivia@example.test',
    title: 'Where is my order?',
    assigneeId: 'user_ann',
    lastMessageAt: at(20),
    lastMessagePreview: 'Reopened',
  });
  await seedMessage('dmsg_t1', 'dconv_thread', 1, { body: 'Where is my order?', metadata: { clientId: 'cid-1' } });
  await seedMessage('dmsg_t2', 'dconv_thread', 2, { authorType: 'agent', authorId: 'user_ann', body: 'Let me check that for you' });
  await seedMessage('dmsg_t3', 'dconv_thread', 3, { kind: 'note', authorType: 'agent', authorId: 'user_ann', body: 'VIP customer' });
  await seedMessage('dmsg_t4', 'dconv_thread', 4, {
    kind: 'event',
    authorType: 'system',
    authorId: null,
    body: null,
    metadata: { eventType: 'assigned', assigneeId: 'user_ann', auto: true },
  });
  await seedMessage('dmsg_t5', 'dconv_thread', 5, {
    kind: 'event',
    authorType: 'agent',
    authorId: 'user_ann',
    body: null,
    metadata: { eventType: 'attributes_changed', changes: [{ field: 'priority', from: null, to: 'high' }] },
  });
  await seedMessage('dmsg_t6', 'dconv_thread', 6, { authorType: 'bot', authorId: null, body: 'I am the bot' });
  await seedMessage('dmsg_t7', 'dconv_thread', 7, { authorType: 'agent', authorId: 'user_viewer', body: 'Vic here' });
  await seedMessage('dmsg_t8', 'dconv_thread', 8, { authorType: 'agent', authorId: 'user_gone', body: 'Gone agent' });
  await seedMessage('dmsg_t9', 'dconv_thread', 9, {
    body: null,
    attachments: [{ name: 'photo.png', url: PHOTO_URL, contentType: 'image/png', filesize: 2048, width: 640, height: 480 }],
  });
  await seedMessage('dmsg_t10', 'dconv_thread', 10, {
    kind: 'event',
    authorType: 'system',
    authorId: null,
    body: null,
    metadata: { eventType: 'reopened' },
  });

  // Listing: an unassigned one the team has yet to answer, and a closed, rated one.
  await seedConversation('dconv_waiting', 2, {
    visitorId: 'vis_owner',
    name: 'Olivia',
    email: 'olivia@example.test',
    title: 'Billing question',
    waitingSince: at(30),
    createdAt: at(5),
    updatedAt: at(5),
    lastMessageAt: at(30),
    lastMessagePreview: 'Can I get an invoice?',
  });
  await seedConversation('dconv_done', 3, {
    visitorId: 'vis_owner',
    name: 'Olivia',
    email: 'olivia@example.test',
    title: 'Password reset',
    state: 'closed',
    assigneeId: 'user_viewer',
    createdAt: at(2),
    updatedAt: at(2),
    lastMessageAt: at(10),
    lastMessagePreview: 'Resolved',
    rating: 4,
    ratingComment: 'Fast',
    ratedAt: at(11),
  });
  await seedConversation('dconv_other', 4, { visitorId: 'vis_other', name: 'Oscar', email: null, title: 'Not yours' });
  await seedMessage('dmsg_o1', 'dconv_other', 1, { authorId: 'vis_other', body: 'Not yours' });

  // Ordering: by last activity, or by creation when there was none.
  await seedConversation('dconv_s_a', 10, { visitorId: 'vis_sort', createdAt: at(1), lastMessageAt: at(30) });
  await seedConversation('dconv_s_b', 11, { visitorId: 'vis_sort', createdAt: at(20), lastMessageAt: null });
  await seedConversation('dconv_s_c', 12, { visitorId: 'vis_sort', createdAt: at(10), lastMessageAt: at(5) });
  // The history is capped at 25 conversations.
  for (let n = 1; n <= 27; n++) {
    const suffix = String(n).padStart(2, '0');
    await seedConversation(`dconv_m${suffix}`, 100 + n, { visitorId: 'vis_many', lastMessageAt: at(n) });
  }

  // For identify: one without contact details, one that has them already.
  await seedConversation('dconv_bare', 20, { visitorId: 'vis_attach', name: null, email: null });
  await seedConversation('dconv_known', 21, { visitorId: 'vis_attach', name: 'Old Name', email: 'old@example.test' });
  await seedConversation('dconv_half', 22, { visitorId: 'vis_attach', name: 'Half Name', email: null });

  // For messages and ratings, one conversation per scenario.
  await seedConversation('dconv_msg_text', 30, { assigneeId: 'user_ann' });
  await seedConversation('dconv_msg_wait', 31, { waitingSince: at(1) });
  await seedConversation('dconv_msg_closed', 32, { state: 'closed' });
  await seedConversation('dconv_msg_all', 33);
  await seedConversation('dconv_att', 34, { assigneeId: 'user_ann', waitingSince: at(1) });
  await seedConversation('dconv_rate_1', 40, { state: 'closed', assigneeId: 'user_ann' });
  await seedConversation('dconv_rate_2', 41, { state: 'closed' });
  await seedConversation('dconv_rate_3', 42, { state: 'closed' });
  await seedConversation('dconv_rate_open', 43);
  await seedConversation('dconv_rate_done', 44, { state: 'closed', rating: 2, ratedAt: at(3) });
  await seedConversation('dconv_rate_bad', 45, { state: 'closed' });
}, 120_000);

describe('POST /api/conversations/identify', () => {
  /** The visitor these tests register: a session the route started. */
  let nina: VisitorSession;

  it('stores what a visitor typed on the visitor the token names', async () => {
    nina = await session();
    expect(nina.visitor).toEqual({ id: expect.stringMatching(/^dvis_/), name: null, email: null, verified: false });
    const res = await call(
      `${BASE}/identify`,
      json({ name: '  Nina  ', email: ' Nina@Example.TEST ' }, { token: nina.visitorToken }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { visitor: { id: nina.visitor.id, name: 'Nina', email: 'nina@example.test', verified: false } },
    });
    const [row] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, nina.visitor.id));
    expect(row).toMatchObject({ name: 'Nina', email: 'nina@example.test', phone: null, widgetId: WIDGET, verifiedEmail: null });
  });

  it('answers a visitor that typed nothing as it is', async () => {
    const { visitor, visitorToken: token } = await session();
    const res = await call(`${BASE}/identify`, json({}, { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { visitor: { id: visitor.id, name: null, email: null, verified: false } },
    });
  });

  it('updates a known visitor and keeps what it was not given', async () => {
    const before = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, nina.visitor.id));
    const res = await call(`${BASE}/identify`, json({ name: 'Nina B.' }, { token: nina.visitorToken }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { visitor: { id: nina.visitor.id, name: 'Nina B.', email: 'nina@example.test', verified: false } },
    });
    const [row] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, nina.visitor.id));
    expect(row!.name).toBe('Nina B.');
    expect(row!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before[0]!.lastSeenAt.getTime());

    // A blank name is no name: the stored one stays.
    const blank = await call(
      `${BASE}/identify`,
      json({ name: '   ', email: 'NINA@other.test' }, { token: nina.visitorToken }),
    );
    expect(await blank.json()).toEqual({
      success: true,
      data: { visitor: { id: nina.visitor.id, name: 'Nina B.', email: 'nina@other.test', verified: false } },
    });
  });

  it('ignores a visitor id in the body: the visitor is the token’s', async () => {
    const res = await call(`${BASE}/identify`, as('vis_nobody', { visitorId: 'vis_owner', name: 'Not Olivia' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { visitor: { id: string } } }).data.visitor.id).toBe('vis_nobody');
    const [owner] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, 'vis_owner'));
    expect(owner!.name).toBeNull();
  });

  it('puts the contact details on the visitor’s conversations that lack them, never over existing ones', async () => {
    const res = await call(`${BASE}/identify`, as('vis_attach', { name: 'Anna', email: 'Anna@Example.TEST' }));
    expect(res.status).toBe(200);

    const rows = await tenantDb
      .select({ id: deskConversations.id, name: deskConversations.name, email: deskConversations.email })
      .from(deskConversations)
      .where(eq(deskConversations.visitorId, 'vis_attach'))
      .orderBy(deskConversations.id);
    expect(rows).toEqual([
      { id: 'dconv_bare', name: 'Anna', email: 'anna@example.test' },
      { id: 'dconv_half', name: 'Half Name', email: 'anna@example.test' },
      { id: 'dconv_known', name: 'Old Name', email: 'old@example.test' },
    ]);
  });

  it('refuses a request without a visitor token, or with an address that is no address', async () => {
    const missing = await call(`${BASE}/identify`, json({ visitorId: 'vis_owner', name: 'Nobody' }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(tokenRequired);

    const { visitor, visitorToken: token } = await session();
    const badEmail = await call(`${BASE}/identify`, json({ email: 'not-an-email' }, { token }));
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toEqual(
      zodRefusal({ validation: 'email', code: 'invalid_string', message: 'Invalid email', path: ['email'] }),
    );
    const [row] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, visitor.id));
    expect(row).toMatchObject({ name: null, email: null });
    const [owner] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, 'vis_owner'));
    expect(owner!.name).toBeNull();
  });
});

describe('GET /api/conversations', () => {
  it('lists the visitor’s conversations by last activity, and nobody else’s', async () => {
    const res = await call(BASE, getAs(tokenOf('vis_owner')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: true; data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      publicConversation({
        id: 'dconv_waiting',
        conversationNumber: 2,
        title: 'Billing question',
        createdAt: at(5).toISOString(),
        lastMessageAt: at(30).toISOString(),
        lastMessagePreview: 'Can I get an invoice?',
        lastMessageFromTeam: false,
      }),
      publicConversation({
        id: 'dconv_thread',
        conversationNumber: 1,
        title: 'Where is my order?',
        lastMessageAt: at(20).toISOString(),
        lastMessagePreview: 'Reopened',
        lastMessageFromTeam: true,
        assignee: { name: 'Ann', avatar: ANN_FACE },
      }),
      publicConversation({
        id: 'dconv_done',
        conversationNumber: 3,
        title: 'Password reset',
        state: 'closed',
        createdAt: at(2).toISOString(),
        lastMessageAt: at(10).toISOString(),
        lastMessagePreview: 'Resolved',
        lastMessageFromTeam: true,
        assignee: { name: 'Vic', avatar: null },
        rating: 4,
      }),
    ]);
  });

  it('answers an empty list for a visitor with no conversations, whatever the query asks for', async () => {
    for (const path of [BASE, `${BASE}?visitorId=vis_owner`]) {
      const res = await call(path, getAs(tokenOf('vis_nobody')));
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toEqual({ success: true, data: [] });
    }
  });

  it('orders by the last message, or by creation for a conversation with none', async () => {
    const res = await call(BASE, getAs(tokenOf('vis_sort')));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual(['dconv_s_a', 'dconv_s_b', 'dconv_s_c']);
  });

  it('caps the history at the 25 most recent', async () => {
    const res = await call(BASE, getAs(tokenOf('vis_many')));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(25);
    expect(body.data[0]!.id).toBe('dconv_m27');
    expect(body.data[24]!.id).toBe('dconv_m03');
  });

  it('needs a visitor token, and one of ours', async () => {
    const res = await call(`${BASE}?visitorId=vis_owner`, get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(tokenRequired);

    const forged = await call(BASE, getAs(await visitorToken('vis_owner', { secret: 'not-the-worker-secret' })));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual(tokenInvalid);
  });
});

describe('POST /api/conversations', () => {
  it('starts a conversation with the visitor’s first message and tells the team', async () => {
    const sam = await session();
    const res = await call(
      BASE,
      json(
        { name: '  Sam Starter ', email: 'Sam@Example.TEST', body: '  Hello   there  ', clientId: 'c-1' },
        { token: sam.visitorToken },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: true;
      data: { conversation: { id: string; conversationNumber: number }; messages: unknown[]; message: { id: string } };
    };
    const message = publicMessage({
      id: expect.stringMatching(MESSAGE_ID),
      conversationId: body.data.conversation.id,
      body: 'Hello   there',
      clientId: 'c-1',
      createdAt: expect.any(String),
    });
    expect(body).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: expect.stringMatching(CONVERSATION_ID),
          conversationNumber: expect.any(Number),
          title: 'Hello there',
          createdAt: expect.any(String),
          lastMessageAt: expect.any(String),
          lastMessagePreview: 'Hello there',
        }),
        messages: [message],
        message,
      },
    });
    const id = body.data.conversation.id;

    // The visitor is registered with what they gave, and the conversation says so too.
    const [visitor] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, sam.visitor.id));
    expect(visitor).toMatchObject({ name: 'Sam Starter', email: 'sam@example.test', widgetId: WIDGET });
    const [conversation] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id));
    expect(conversation).toMatchObject({
      conversationNumber: body.data.conversation.conversationNumber,
      title: 'Hello there',
      state: 'open',
      channel: 'messenger',
      visitorId: sam.visitor.id,
      name: 'Sam Starter',
      email: 'sam@example.test',
      contactId: null,
      assigneeId: null,
      priority: null,
      tags: [],
      lastMessagePreview: 'Hello there',
      rating: null,
      ratedAt: null,
    });
    expect(conversation!.waitingSince).toEqual(conversation!.lastMessageAt);
    const [stored] = await tenantDb.select().from(deskMessages).where(eq(deskMessages.conversationId, id));
    expect(stored).toMatchObject({
      id: body.data.message.id,
      kind: 'message',
      body: 'Hello   there',
      authorType: 'visitor',
      authorId: sam.visitor.id,
      attachments: null,
      metadata: { clientId: 'c-1' },
    });

    // Ann is the only teammate who can be told.
    const [note] = await notificationsFor(id, 1);
    expect(note).toMatchObject({
      userId: 'user_ann',
      title: 'New conversation from Sam Starter',
      body: 'Hello there',
      category: 'helpdesk',
      notificationType: 'message_received',
      entityType: 'desk_conversation',
      entityId: id,
      actionUrl: `/welddesk/inbox/${id}`,
      severity: 'info',
      actorType: 'system',
      actorId: null,
      deliveredInApp: true,
      isRead: false,
    });
  });

  it('numbers conversations one after the highest', async () => {
    const [{ max }] = await tenantDb
      .select({ max: sql<number>`max(${deskConversations.conversationNumber})` })
      .from(deskConversations);
    const res = await call(BASE, json({ body: 'Numbered' }, { token: (await session()).visitorToken }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { conversation: { conversationNumber: number } } };
    expect(body.data.conversation.conversationNumber).toBe(Number(max) + 1);
  });

  it('names an anonymous visitor "Visitor" in the notification, and a known one by what the visitor row says', async () => {
    const { visitorToken: token } = await session();
    const anonymous = await call(BASE, json({ body: 'Anyone there?' }, { token }));
    const anonymousId = ((await anonymous.json()) as { data: { conversation: { id: string } } }).data.conversation.id;
    const [first] = await notificationsFor(anonymousId, 1);
    expect(first!.title).toBe('New conversation from Visitor');

    // The visitor row has a name by now: the next conversation carries it.
    await call(`${BASE}/identify`, json({ email: 'anon@example.test' }, { token }));
    const known = await call(BASE, json({ body: 'Again' }, { token }));
    const knownId = ((await known.json()) as { data: { conversation: { id: string } } }).data.conversation.id;
    const [second] = await notificationsFor(knownId, 1);
    expect(second!.title).toBe('New conversation from anon@example.test');
    const [conversation] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, knownId));
    expect(conversation).toMatchObject({ name: null, email: 'anon@example.test' });
  });

  it('titles the conversation with a preview of the message: whitespace collapsed, cut at 200 characters', async () => {
    const long = `${'word '.repeat(60)}end`;
    const res = await call(BASE, json({ body: long }, { token: (await session()).visitorToken }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { conversation: { id: string; title: string; lastMessagePreview: string } } };
    const preview = `${long.slice(0, 197)}…`;
    expect(data.conversation.title).toBe(preview);
    expect(data.conversation.lastMessagePreview).toBe(preview);
    expect(preview).toHaveLength(198);
    // The notification carries the first 180 characters.
    const [note] = await notificationsFor(data.conversation.id, 1);
    expect(note!.body).toBe(long.slice(0, 180));
  });

  it('takes a message of 10 000 characters and refuses one of 10 001', async () => {
    const { visitorToken: token } = await session();
    const ok = await call(BASE, json({ body: 'a'.repeat(10_000) }, { token }));
    expect(ok.status).toBe(201);
    const { data } = (await ok.json()) as { data: { message: { body: string }; conversation: { id: string; title: string } } };
    expect(data.message.body).toHaveLength(10_000);
    expect(data.conversation.title).toBe(`${'a'.repeat(197)}…`);
    await notificationsFor(data.conversation.id, 1);

    const tooBig = await call(BASE, json({ body: 'a'.repeat(10_001) }, { token }));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toEqual(
      zodRefusal({
        code: 'too_big',
        maximum: 10_000,
        type: 'string',
        inclusive: true,
        exact: false,
        message: 'String must contain at most 10000 character(s)',
        path: ['body'],
      }),
    );
  });

  it('refuses a body that is missing, empty or only spaces, and a request without a visitor token', async () => {
    const { visitor, visitorToken: token } = await session();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, required(['body'])],
      [{ body: '' }, tooSmallString(['body'])],
      [{ body: '   ' }, tooSmallString(['body'])],
    ];
    for (const [payload, issue] of cases) {
      const res = await call(BASE, json(payload, { token }));
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(await res.json(), JSON.stringify(payload)).toEqual(zodRefusal(issue));
    }
    // The token is checked first: without one even a good body is refused.
    const anonymous = await call(BASE, json({ visitorId: visitor.id, body: 'Hello' }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual(tokenRequired);
    expect(await tenantDb.select().from(deskConversations).where(eq(deskConversations.visitorId, visitor.id))).toEqual([]);
  });
});

describe('GET /api/conversations/:id', () => {
  it('answers the conversation and its public messages, with the names of the teammates', async () => {
    const res = await read('dconv_thread', 'vis_owner');
    expect(res.status).toBe(200);
    const created = (iso: number) => at(iso).toISOString();
    expect(await res.json()).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: 'dconv_thread',
          conversationNumber: 1,
          title: 'Where is my order?',
          lastMessageAt: created(20),
          lastMessagePreview: 'Reopened',
          lastMessageFromTeam: true,
          assignee: { name: 'Ann', avatar: ANN_FACE },
        }),
        // No note (t3) and no ticket-field change (t5).
        messages: [
          publicMessage({ id: 'dmsg_t1', conversationId: 'dconv_thread', body: 'Where is my order?', clientId: 'cid-1', createdAt: created(1) }),
          publicMessage({
            id: 'dmsg_t2',
            conversationId: 'dconv_thread',
            body: 'Let me check that for you',
            authorType: 'agent',
            authorName: 'Ann',
            authorAvatar: ANN_FACE,
            createdAt: created(2),
          }),
          publicMessage({
            id: 'dmsg_t4',
            conversationId: 'dconv_thread',
            kind: 'event',
            authorType: 'system',
            eventType: 'assigned',
            createdAt: created(4),
          }),
          publicMessage({
            id: 'dmsg_t6',
            conversationId: 'dconv_thread',
            body: 'I am the bot',
            authorType: 'bot',
            authorName: 'Bot',
            createdAt: created(6),
          }),
          publicMessage({
            id: 'dmsg_t7',
            conversationId: 'dconv_thread',
            body: 'Vic here',
            authorType: 'agent',
            authorName: 'Vic',
            createdAt: created(7),
          }),
          // An agent who is no longer on the team still answers as "Support".
          publicMessage({
            id: 'dmsg_t8',
            conversationId: 'dconv_thread',
            body: 'Gone agent',
            authorType: 'agent',
            authorName: 'Support',
            createdAt: created(8),
          }),
          publicMessage({
            id: 'dmsg_t9',
            conversationId: 'dconv_thread',
            attachments: [
              { name: 'photo.png', url: PHOTO_URL, contentType: 'image/png', filesize: 2048, width: 640, height: 480 },
            ],
            createdAt: created(9),
          }),
          publicMessage({
            id: 'dmsg_t10',
            conversationId: 'dconv_thread',
            kind: 'event',
            authorType: 'system',
            eventType: 'reopened',
            createdAt: created(10),
          }),
        ],
      },
    });
  });

  it('answers a conversation with no messages and no assignee', async () => {
    const res = await read('dconv_waiting', 'vis_owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: 'dconv_waiting',
          conversationNumber: 2,
          title: 'Billing question',
          createdAt: at(5).toISOString(),
          lastMessageAt: at(30).toISOString(),
          lastMessagePreview: 'Can I get an invoice?',
        }),
        messages: [],
      },
    });
  });

  it('is a 404 for another visitor’s conversation, and for one that does not exist', async () => {
    for (const [id, visitorId] of [
      ['dconv_thread', 'vis_other'],
      ['dconv_other', 'vis_owner'],
      ['dconv_nowhere', 'vis_owner'],
    ] as const) {
      const res = await read(id, visitorId);
      expect(res.status, `${id} ${visitorId}`).toBe(404);
      expect(await res.json(), `${id} ${visitorId}`).toEqual(notFound(id));
    }
  });

  it('needs a visitor token: a visitor id in the query counts for nothing', async () => {
    const res = await call(`${BASE}/dconv_thread?visitorId=vis_owner`, get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(tokenRequired);

    const other = await call(`${BASE}/dconv_thread?visitorId=vis_owner`, getAs(tokenOf('vis_other')));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(notFound('dconv_thread'));
  });
});

describe('POST /api/conversations/:id/messages', () => {
  it('stores the message, answers the conversation as it now stands and tells the assignee', async () => {
    const res = await send('dconv_msg_text', 'vis_writer', { body: '  Any news?  ', clientId: 'cid-2' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { message: { id: string } } };
    expect(body).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: 'dconv_msg_text',
          conversationNumber: 30,
          title: 'dconv_msg_text',
          lastMessageAt: expect.any(String),
          lastMessagePreview: 'Any news?',
          lastMessageFromTeam: false,
          assignee: { name: 'Ann', avatar: ANN_FACE },
        }),
        message: publicMessage({
          id: expect.stringMatching(MESSAGE_ID),
          conversationId: 'dconv_msg_text',
          body: 'Any news?',
          clientId: 'cid-2',
          createdAt: expect.any(String),
        }),
      },
    });

    const [conversation] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_msg_text'));
    expect(conversation).toMatchObject({ state: 'open', assigneeId: 'user_ann', lastMessagePreview: 'Any news?' });
    expect(conversation!.waitingSince).toEqual(conversation!.lastMessageAt);
    const [stored] = await tenantDb.select().from(deskMessages).where(eq(deskMessages.id, body.data.message.id));
    expect(stored).toMatchObject({
      conversationId: 'dconv_msg_text',
      kind: 'message',
      body: 'Any news?',
      authorType: 'visitor',
      authorId: 'vis_writer',
      attachments: null,
      metadata: { clientId: 'cid-2' },
    });

    // The ball moved to the team: the assignee hears about it, by the visitor's name.
    const [note] = await notificationsFor('dconv_msg_text', 1);
    expect(note).toMatchObject({
      userId: 'user_ann',
      title: 'Wendy replied',
      body: 'Any news?',
      notificationType: 'message_received',
      actionUrl: '/welddesk/inbox/dconv_msg_text',
    });
  });

  it('does not tell the team again while it is already waiting for an answer', async () => {
    // Team already waiting (dconv_msg_wait) and the thread just written to (dconv_msg_text).
    for (const id of ['dconv_msg_wait', 'dconv_msg_text']) {
      const res = await send(id, 'vis_writer', { body: 'Hello? Anyone?' });
      expect(res.status, id).toBe(201);
    }
    await settle();
    expect(await tenantDb.select().from(notifications).where(eq(notifications.entityId, 'dconv_msg_wait'))).toEqual([]);
    expect(await tenantDb.select().from(notifications).where(eq(notifications.entityId, 'dconv_msg_text'))).toHaveLength(1);
  });

  it('reopens a closed conversation and tells the team', async () => {
    const res = await send('dconv_msg_closed', 'vis_writer', { body: 'One more thing' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { conversation: Record<string, unknown> } };
    expect(data.conversation).toMatchObject({ id: 'dconv_msg_closed', state: 'open', lastMessageFromTeam: false });

    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_msg_closed'));
    expect(row!.state).toBe('open');
    expect(row!.waitingSince).not.toBeNull();
    const [note] = await notificationsFor('dconv_msg_closed', 1);
    expect(note).toMatchObject({ userId: 'user_ann', title: 'Wendy replied' });
  });

  it('tells every active internal teammate but the viewers when nobody has the conversation', async () => {
    await tenantDb.insert(workspaceMembers).values(member('user_bob', { name: 'Bob Builder', role: 'ADMIN' }));
    try {
      const res = await send('dconv_msg_all', 'vis_writer', { body: 'Is anyone free?' });
      expect(res.status).toBe(201);
      const notes = await notificationsFor('dconv_msg_all', 2);
      expect(notes.map((n: { userId: string }) => n.userId)).toEqual(['user_ann', 'user_bob']);
    } finally {
      await tenantDb.delete(workspaceMembers).where(eq(workspaceMembers.userId, 'user_bob'));
    }
  });

  it('refuses a message with neither text nor files', async () => {
    const issue = {
      code: 'custom',
      message: 'A message needs text or at least one attachment',
      path: ['body'],
    };
    for (const payload of [{}, { body: '   ' }, { body: '', attachments: [] }]) {
      const res = await send('dconv_msg_all', 'vis_writer', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(await res.json(), JSON.stringify(payload)).toEqual(zodRefusal(issue));
    }
  });

  it('is a 404 for a conversation of another visitor or none, before any attachment is looked at', async () => {
    for (const [id, visitorId] of [
      ['dconv_msg_text', 'vis_other'],
      ['dconv_other', 'vis_writer'],
      ['dconv_nowhere', 'vis_writer'],
    ] as const) {
      const res = await send(id, visitorId, {
        body: 'Hello',
        attachments: [{ name: 'x.png', url: 'https://elsewhere.test/x.png', contentType: 'image/png', filesize: 1 }],
      });
      expect(res.status, `${id} ${visitorId}`).toBe(404);
      expect(await res.json(), `${id} ${visitorId}`).toEqual(notFound(id));
    }
  });

  it('needs a visitor token: the visitor id the widget used to send counts for nothing', async () => {
    const res = await call(`${BASE}/dconv_msg_all/messages`, json({ visitorId: 'vis_writer', body: 'Hello' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(tokenRequired);

    const other = await call(`${BASE}/dconv_msg_all/messages`, as('vis_other', { visitorId: 'vis_writer', body: 'Hello' }));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(notFound('dconv_msg_all'));
  });
});

describe('POST /api/conversations/:id/messages: attachments', () => {
  const key = (name: string, conversationId = 'dconv_att', org = ORG) => `widgets/${org}/${conversationId}/${name}`;
  const url = (name: string, conversationId = 'dconv_att') => `${FILES_ORIGIN}/${key(name, conversationId)}`;
  const claim = (name: string, fileName: string, extra: Record<string, unknown> = {}) => ({
    name: fileName,
    url: url(name),
    contentType: 'application/x-claimed',
    filesize: 1,
    ...extra,
  });

  beforeAll(async () => {
    const put = (name: string, size: number, contentType?: string, conversationId = 'dconv_att') =>
      storage.put(key(name, conversationId), new Uint8Array(size).fill(7), contentType ? { httpMetadata: { contentType } } : undefined);
    await put('1700000000001_att_aaa111_photo.png', 2048, 'image/png');
    await put('1700000000002_att_bbb222_report.pdf', 10, 'application/pdf');
    await put('1700000000003_att_ccc333_notes.txt', 5);
    // Uploaded for another conversation.
    await put('1700000000004_att_ddd444_theirs.png', 3, 'image/png', 'dconv_msg_all');
  });

  it('takes files uploaded for the conversation and trusts the bucket for their size and type', async () => {
    const res = await send('dconv_att', 'vis_writer', {
      attachments: [
        claim('1700000000001_att_aaa111_photo.png', 'My photo.png', { width: 640, height: 480 }),
        claim('1700000000002_att_bbb222_report.pdf', 'report.pdf'),
        // Stored without a type: the client's claim stands.
        claim('1700000000003_att_ccc333_notes.txt', 'notes.txt', { contentType: 'text/plain' }),
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { message: { id: string } } };
    const attachments = [
      { name: 'My photo.png', url: url('1700000000001_att_aaa111_photo.png'), contentType: 'image/png', filesize: 2048, width: 640, height: 480 },
      { name: 'report.pdf', url: url('1700000000002_att_bbb222_report.pdf'), contentType: 'application/pdf', filesize: 10 },
      { name: 'notes.txt', url: url('1700000000003_att_ccc333_notes.txt'), contentType: 'text/plain', filesize: 5 },
    ];
    expect(body).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: 'dconv_att',
          conversationNumber: 34,
          title: 'dconv_att',
          lastMessageAt: expect.any(String),
          lastMessagePreview: '📎 My photo.png +2',
          assignee: { name: 'Ann', avatar: ANN_FACE },
        }),
        message: publicMessage({
          id: expect.stringMatching(MESSAGE_ID),
          conversationId: 'dconv_att',
          body: null,
          attachments,
          createdAt: expect.any(String),
        }),
      },
    });
    const [stored] = await tenantDb.select().from(deskMessages).where(eq(deskMessages.id, body.data.message.id));
    expect(stored).toMatchObject({ body: null, attachments });
  });

  it('keeps the text of a message that has files too', async () => {
    const res = await send('dconv_att', 'vis_writer', {
      body: 'See attached',
      attachments: [claim('1700000000002_att_bbb222_report.pdf', 'report.pdf')],
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { message: Record<string, unknown> } };
    expect(data.message).toMatchObject({
      body: 'See attached',
      attachments: [{ name: 'report.pdf', contentType: 'application/pdf', filesize: 10 }],
    });
  });

  it('refuses a file this worker did not store for this conversation', async () => {
    const refused = (message: string) => badRequest(message);
    const foreign = [
      // Another host, another workspace, another conversation, a name of the wrong shape, a query, a path out of the folder.
      { ...claim('x', 'a.png'), url: 'https://elsewhere.test/widgets/org_acme/dconv_att/1700000000001_att_aaa111_photo.png' },
      { ...claim('x', 'a.png'), url: `${FILES_ORIGIN}/widgets/org_other/dconv_att/1700000000001_att_aaa111_photo.png` },
      { ...claim('x', 'a.png'), url: url('1700000000004_att_ddd444_theirs.png', 'dconv_msg_all') },
      { ...claim('x', 'a.png'), url: url('photo.png') },
      { ...claim('x', 'a.png'), url: `${url('1700000000001_att_aaa111_photo.png')}?download=1` },
      { ...claim('x', 'a.png'), url: url('1700000000001_att_aaa111_../../dconv_msg_all/x.png') },
      { ...claim('x', 'a.png'), url: 'javascript:alert(1)' },
      { ...claim('x', 'a.png'), url: '' },
    ];
    for (const attachment of foreign) {
      const res = await send('dconv_att', 'vis_writer', { attachments: [attachment] });
      expect(res.status, attachment.url).toBe(400);
      expect(await res.json(), attachment.url).toEqual(refused('Attachment was not uploaded to this conversation'));
    }
    // One bad file refuses the whole message.
    const mixed = await send('dconv_att', 'vis_writer', {
      body: 'Two files',
      attachments: [claim('1700000000001_att_aaa111_photo.png', 'photo.png'), foreign[0]],
    });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toEqual(refused('Attachment was not uploaded to this conversation'));
  });

  it('refuses a file whose object is not in the bucket', async () => {
    const res = await send('dconv_att', 'vis_writer', {
      attachments: [claim('1700000000009_att_zzz999_missing.png', 'missing.png')],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(badRequest('Attachment was not found'));
  });

  it('refuses files when the worker has no public bucket URL', async () => {
    const res = await send(
      'dconv_att',
      'vis_writer',
      { attachments: [claim('1700000000001_att_aaa111_photo.png', 'photo.png')] },
      { R2_PUBLIC_URL: undefined },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(badRequest('File attachments are not available'));
  });

  it('writes nothing for a refused message', async () => {
    const rows = await tenantDb
      .select({ id: deskMessages.id })
      .from(deskMessages)
      .where(and(eq(deskMessages.conversationId, 'dconv_att'), eq(deskMessages.kind, 'message')));
    // The two accepted messages above, nothing from the refusals.
    expect(rows).toHaveLength(2);
  });
});

describe('POST /api/conversations/:id/rating', () => {
  it('rates a closed conversation, puts the rating on the timeline and answers both', async () => {
    const res = await rate('dconv_rate_1', 'vis_writer', { rating: 5, comment: '  Great help!  ' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { message: { id: string } } };
    expect(body).toEqual({
      success: true,
      data: {
        conversation: publicConversation({
          id: 'dconv_rate_1',
          conversationNumber: 40,
          title: 'dconv_rate_1',
          state: 'closed',
          lastMessageAt: at(1).toISOString(),
          lastMessageFromTeam: true,
          assignee: { name: 'Ann', avatar: ANN_FACE },
          rating: 5,
        }),
        message: publicMessage({
          id: expect.stringMatching(MESSAGE_ID),
          conversationId: 'dconv_rate_1',
          kind: 'event',
          body: null,
          authorType: 'visitor',
          eventType: 'rated',
          createdAt: expect.any(String),
        }),
      },
    });

    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_rate_1'));
    expect(row).toMatchObject({ state: 'closed', rating: 5, ratingComment: 'Great help!' });
    expect(row!.ratedAt).toBeInstanceOf(Date);
    const [event] = await tenantDb.select().from(deskMessages).where(eq(deskMessages.id, body.data.message.id));
    expect(event).toMatchObject({
      kind: 'event',
      body: null,
      authorType: 'visitor',
      authorId: 'vis_writer',
      metadata: { eventType: 'rated', rating: 5, ratingComment: 'Great help!' },
    });
  });

  it('takes a rating without a comment, or with a blank one', async () => {
    const plain = await rate('dconv_rate_2', 'vis_writer', { rating: 1 });
    expect(plain.status).toBe(201);
    const blank = await rate('dconv_rate_3', 'vis_writer', { rating: 3, comment: '   ' });
    expect(blank.status).toBe(201);
    for (const [id, rating] of [
      ['dconv_rate_2', 1],
      ['dconv_rate_3', 3],
    ] as const) {
      const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id));
      expect(row).toMatchObject({ rating, ratingComment: null });
      const [event] = await tenantDb
        .select()
        .from(deskMessages)
        .where(and(eq(deskMessages.conversationId, id), eq(deskMessages.kind, 'event')));
      expect(event!.metadata).toEqual({ eventType: 'rated', rating, ratingComment: null });
    }
  });

  it('is a 409 for a conversation still open, or one that was rated already', async () => {
    const open = await rate('dconv_rate_open', 'vis_writer', { rating: 4 });
    expect(open.status).toBe(409);
    expect(await open.json()).toEqual(conflict('Only a closed conversation can be rated'));

    const done = await rate('dconv_rate_done', 'vis_writer', { rating: 5 });
    expect(done.status).toBe(409);
    expect(await done.json()).toEqual(conflict('This conversation was already rated'));
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_rate_done'));
    expect(row!.rating).toBe(2);
  });

  it('is a 404 for another visitor’s conversation, and for one that does not exist', async () => {
    for (const [id, visitorId] of [
      ['dconv_rate_bad', 'vis_other'],
      ['dconv_other', 'vis_writer'],
      ['dconv_nowhere', 'vis_writer'],
    ] as const) {
      const res = await rate(id, visitorId, { rating: 5 });
      expect(res.status, `${id} ${visitorId}`).toBe(404);
      expect(await res.json(), `${id} ${visitorId}`).toEqual(notFound(id));
    }
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_rate_bad'));
    expect(row!.rating).toBeNull();
  });

  it('needs a visitor token', async () => {
    const res = await call(`${BASE}/dconv_rate_bad/rating`, json({ visitorId: 'vis_writer', rating: 5 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(tokenRequired);
  });

  it('refuses a rating outside 1 to 5, or not a whole number', async () => {
    const cases: Array<[number, Record<string, unknown>]> = [
      [
        0,
        {
          code: 'too_small',
          minimum: 1,
          type: 'number',
          inclusive: true,
          exact: false,
          message: 'Number must be greater than or equal to 1',
          path: ['rating'],
        },
      ],
      [
        6,
        {
          code: 'too_big',
          maximum: 5,
          type: 'number',
          inclusive: true,
          exact: false,
          message: 'Number must be less than or equal to 5',
          path: ['rating'],
        },
      ],
      [
        3.5,
        { code: 'invalid_type', expected: 'integer', received: 'float', message: 'Expected integer, received float', path: ['rating'] },
      ],
    ];
    for (const [rating, issue] of cases) {
      const res = await rate('dconv_rate_bad', 'vis_writer', { rating });
      expect(res.status, String(rating)).toBe(400);
      expect(await res.json(), String(rating)).toEqual(zodRefusal(issue));
    }
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, 'dconv_rate_bad'));
    expect(row!.rating).toBeNull();
  });
});
