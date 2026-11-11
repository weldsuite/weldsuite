/**
 * WeldDesk problems on pglite: CRUD and the status timestamp rules, the
 * known-error refusal, list filters and incident counts, deleting (the
 * incidents are unlinked), sharing the workaround as a note or a reply on the
 * open incidents only, the article, permission gates and the published events.
 * Seeded rows have fixed ids and timestamps, and the list tests run before
 * anything is written with the wall clock, so the suite runs against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import {
  deskProblemCreatedSchema,
  deskProblemIncidentSchema,
  deskProblemShareSchema,
  deskProblemWithCountsSchema,
} from '@weldsuite/core-api-client/schemas/desk-problems';
import { deskProblemsRoutes } from './index';

vi.setConfig({ testTimeout: 120_000 });

// What the routes publish, kept to assert on; the real publisher still runs.
const published = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEvent: vi.fn((event: Record<string, unknown>) => {
      const { c: _c, ...rest } = event;
      published.push(JSON.parse(JSON.stringify(rest)) as Record<string, unknown>);
      actual.publishEntityEvent(event as never);
    }),
  };
});

const USER = 'user_test_default';
const BASE = '/api/desk/problems';

let db: Database;

const app = (keys: string[], env: Record<string, unknown> = {}) =>
  createTestApp(BASE, deskProblemsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: { DATABASE_URL_MASTER: undefined, ...env } as never,
  });
const reader = () => app(['problems:read']);
const writer = (env: Record<string, unknown> = {}) =>
  app(['problems:read', 'problems:create', 'problems:update', 'problems:delete', 'articles:create'], env);

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

async function seedConversation(id: string, conversationNumber: number, values: Partial<typeof schema.deskConversations.$inferInsert> = {}) {
  await db.insert(schema.deskConversations).values({
    id,
    conversationNumber,
    createdAt: at(conversationNumber % 60),
    updatedAt: at(conversationNumber % 60),
    lastMessageAt: at(conversationNumber % 60),
    ...values,
  });
}

async function seedProblem(id: string, problemNumber: number, values: Partial<typeof schema.deskProblems.$inferInsert> = {}) {
  await db.insert(schema.deskProblems).values({
    id,
    problemNumber,
    title: `Problem ${problemNumber}`,
    createdAt: at(problemNumber),
    updatedAt: at(problemNumber),
    ...values,
  });
}

async function conversation(id: string) {
  const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  return row!;
}

async function messagesOf(conversationId: string): Promise<DeskMessage[]> {
  return db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, conversationId)).orderBy(schema.deskMessages.createdAt, schema.deskMessages.id);
}

async function problemRow(id: string) {
  const [row] = await db.select().from(schema.deskProblems).where(eq(schema.deskProblems.id, id));
  return row;
}

interface Problem {
  id: string;
  problemNumber: number;
  title: string;
  status: string;
  priority: string | null;
  rootCause: string | null;
  workaround: string | null;
  assigneeId: string | null;
  departmentId: string | null;
  articleId: string | null;
  knownErrorAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  incidentCount: number;
  openIncidentCount: number;
}

const reason = async (res: Response) => ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason;
const eventsOf = (entityType: string, action: string) => published.filter((e) => e.entityType === entityType && e.action === action);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_agent', userId: USER, name: 'Ada Lovelace' },
    { id: 'wm_gone', userId: 'user_gone', name: 'Gone', status: 'INACTIVE' },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dept_a', name: 'Payments' },
    { id: 'dept_off', name: 'Closed team', isActive: false },
  ]);

  // The list: one problem per status, the known errors (one resolved since), incidents on two of them.
  await seedProblem('dprob_s1', 1, { title: 'Login loop', status: 'open', description: 'Users bounce back to the login page' });
  await seedProblem('dprob_s2', 2, {
    title: 'Checkout fails',
    status: 'known_error',
    rootCause: 'Gateway timeout',
    workaround: 'Use PayPal instead',
    knownErrorAt: at(2),
  });
  await seedProblem('dprob_s3', 3, { title: 'Old export bug', status: 'resolved', knownErrorAt: at(1), resolvedAt: at(3), workaround: 'Export in CSV' });
  await seedProblem('dprob_s4', 4, { title: 'Typo on invoice', status: 'closed', resolvedAt: at(3), closedAt: at(4) });
  await seedProblem('dprob_s5', 5, { title: 'Slow search', status: 'investigating', assigneeId: USER, departmentId: 'dept_a', priority: 'high' });
  await seedConversation('dconv_l1', 401, { visitorId: 'vis_l1', problemId: 'dprob_s2' });
  await seedConversation('dconv_l2', 402, { visitorId: 'vis_l2', problemId: 'dprob_s2', state: 'closed' });
  await seedConversation('dconv_l3', 403, { visitorId: 'vis_l3', problemId: 'dprob_s2', mergedIntoId: 'dconv_l1' });
  await seedConversation('dconv_l4', 404, { visitorId: 'vis_l4', problemId: 'dprob_s5' });
}, 60_000);

describe('GET /api/desk/problems', () => {
  it('lists open problems first, then done ones, with incident counts', async () => {
    const res = await reader().request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Problem[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((p) => p.id)).toEqual(['dprob_s5', 'dprob_s2', 'dprob_s1', 'dprob_s4', 'dprob_s3']);
    expect(body.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
    const counts = Object.fromEntries(body.data.map((p) => [p.id, [p.incidentCount, p.openIncidentCount]]));
    expect(counts).toMatchObject({ dprob_s2: [3, 1], dprob_s5: [1, 1], dprob_s1: [0, 0] });
  });

  it('filters by status, known errors, owner, team and text', async () => {
    const ids = async (query: string) => ((await (await reader().request(`${BASE}?${query}`)).json()) as { data: Problem[] }).data.map((p) => p.id);
    expect(await ids('status=open,investigating')).toEqual(['dprob_s5', 'dprob_s1']);
    expect(await ids('status=resolved,closed')).toEqual(['dprob_s4', 'dprob_s3']);
    expect(await ids('knownErrors=1')).toEqual(['dprob_s2', 'dprob_s3']);
    expect(await ids(`assigneeId=${USER}`)).toEqual(['dprob_s5']);
    expect(await ids('departmentId=dept_a')).toEqual(['dprob_s5']);
    expect(await ids('q=paypal')).toEqual(['dprob_s2']);
    expect(await ids('q=timeout')).toEqual(['dprob_s2']);
    expect(await ids('q=login%20page')).toEqual(['dprob_s1']);
    expect(await ids('q=%233')).toEqual(['dprob_s3']);
    expect(await ids('q=4')).toEqual(['dprob_s4']);
  });

  it('pages with a cursor and rejects an unknown status', async () => {
    const first = (await (await reader().request(`${BASE}?limit=2`)).json()) as { data: Problem[]; pagination: { hasMore: boolean; cursor: string } };
    expect(first.data.map((p) => p.id)).toEqual(['dprob_s5', 'dprob_s2']);
    expect(first.pagination).toMatchObject({ hasMore: true, cursor: '2' });
    const second = (await (await reader().request(`${BASE}?limit=2&cursor=${first.pagination.cursor}`)).json()) as { data: Problem[] };
    expect(second.data.map((p) => p.id)).toEqual(['dprob_s1', 'dprob_s4']);
    expect((await reader().request(`${BASE}?status=nope`)).status).toBe(400);
  });
});

describe('GET /api/desk/problems/:id', () => {
  it('returns one problem with its counts, and 404s an unknown one', async () => {
    const res = await reader().request(`${BASE}/dprob_s2`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Problem };
    expect(data).toMatchObject({ id: 'dprob_s2', problemNumber: 2, status: 'known_error', workaround: 'Use PayPal instead', incidentCount: 3, openIncidentCount: 1 });
    expect((await reader().request(`${BASE}/dprob_nope`)).status).toBe(404);
  });

  it('lists the linked incidents by number', async () => {
    const res = await reader().request(`${BASE}/dprob_s2/conversations`);
    const { data } = (await res.json()) as { data: Array<{ id: string; conversationNumber: number; state: string }> };
    expect(data.map((c) => [c.id, c.conversationNumber, c.state])).toEqual([
      ['dconv_l1', 401, 'open'],
      ['dconv_l2', 402, 'closed'],
      ['dconv_l3', 403, 'open'],
    ]);
    expect((await reader().request(`${BASE}/dprob_nope/conversations`)).status).toBe(404);
  });
});

describe('POST /api/desk/problems', () => {
  it('creates a problem with the next number and publishes it', async () => {
    const res = await writer().request(BASE, send({ title: '  Emails arrive late ', description: 'Since Monday', priority: 'high', assigneeId: USER, departmentId: 'dept_a' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { problem: Problem; messages: DeskMessage[] } };
    expect(data.problem).toMatchObject({
      problemNumber: 6,
      title: 'Emails arrive late',
      status: 'open',
      priority: 'high',
      assigneeId: USER,
      departmentId: 'dept_a',
      knownErrorAt: null,
      incidentCount: 0,
    });
    expect(data.messages).toEqual([]);
    const created = eventsOf('desk_problem', 'created').at(-1);
    expect(created).toMatchObject({
      // In conformance mode the event kept here is the TypeScript run's, about the row that
      // run created (the answer is Rust's, with Rust's new id); the harness compares the two.
      entityId: conformanceTarget() ? expect.any(String) : data.problem.id,
      data: { problemNumber: 6, title: 'Emails arrive late' },
    });
    expect(created!.entityId).toBe((created!.data as { id: string }).id);
  });

  it('links the given incidents with an internal event on each', async () => {
    await seedConversation('dconv_n1', 411, { visitorId: 'vis_n1' });
    await seedConversation('dconv_n2', 412, { visitorId: 'vis_n2' });
    const res = await writer().request(BASE, send({ title: 'Slow uploads', conversationIds: ['dconv_n1', 'dconv_n2', 'dconv_n1'] }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { problem: Problem; messages: DeskMessage[] } };
    expect(data.problem).toMatchObject({ incidentCount: 2, openIncidentCount: 2 });
    expect(data.messages.map((m) => [m.conversationId, m.metadata?.eventType])).toEqual([
      ['dconv_n1', 'problem_linked'],
      ['dconv_n2', 'problem_linked'],
    ]);
    expect(data.messages[0]?.metadata).toMatchObject({ problemId: data.problem.id, problemNumber: data.problem.problemNumber, problemTitle: 'Slow uploads' });
    expect(isPublicDeskMessage(data.messages[0]!)).toBe(false);
    expect((await conversation('dconv_n1')).problemId).toBe(data.problem.id);
    expect(eventsOf('desk_message', 'created').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a known error without a workaround or root cause, and writes nothing', async () => {
    const before = ((await (await reader().request(BASE)).json()) as { pagination: { totalCount: number } }).pagination.totalCount;
    const refused = await writer().request(BASE, send({ title: 'Mystery', status: 'known_error' }));
    expect(refused.status).toBe(409);
    expect(await reason(refused)).toBe('workaround_required');
    const ok = await writer().request(BASE, send({ title: 'Understood', status: 'known_error', workaround: 'Restart the app' }));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: { problem: Problem } }).data.problem.knownErrorAt).not.toBeNull();
    const after = ((await (await reader().request(BASE)).json()) as { pagination: { totalCount: number } }).pagination.totalCount;
    expect(after).toBe(before + 1);
  });

  it('refuses a merged duplicate and an unknown incident before creating anything', async () => {
    const before = ((await (await reader().request(BASE)).json()) as { pagination: { totalCount: number } }).pagination.totalCount;
    expect(await reason(await writer().request(BASE, send({ title: 'Merged', conversationIds: ['dconv_l3'] })))).toBe('merged');
    expect((await writer().request(BASE, send({ title: 'Nope', conversationIds: ['dconv_nope'] }))).status).toBe(404);
    const after = ((await (await reader().request(BASE)).json()) as { pagination: { totalCount: number } }).pagination.totalCount;
    expect(after).toBe(before);
  });

  it('validates the body, the team and the owner', async () => {
    expect((await writer().request(BASE, send({ title: '  ' }))).status).toBe(400);
    expect((await writer().request(BASE, send({}))).status).toBe(400);
    expect((await writer().request(BASE, send({ title: 'x', priority: 'huge' }))).status).toBe(400);
    const team = await writer().request(BASE, send({ title: 'x', departmentId: 'dept_off' }));
    expect(team.status).toBe(400);
    expect(((await team.json()) as { error: { details: { field: string } } }).error.details.field).toBe('departmentId');
    expect((await writer().request(BASE, send({ title: 'x', departmentId: 'dept_nope' }))).status).toBe(400);
    expect((await writer().request(BASE, send({ title: 'x', assigneeId: 'user_gone' }))).status).toBe(400);
    expect((await writer().request(BASE, send({ title: 'x', assigneeId: 'user_nobody' }))).status).toBe(400);
  });
});

describe('PATCH /api/desk/problems/:id', () => {
  it('moves the status timestamps along the lifecycle', async () => {
    await seedProblem('dprob_u1', 21, { title: 'Lifecycle', status: 'open' });
    const patch = async (body: unknown) => (await writer().request(`${BASE}/dprob_u1`, send(body, 'PATCH'))) as Response;
    const data = async (res: Response) => ((await res.json()) as { data: Problem }).data;

    expect(await data(await patch({ status: 'investigating' }))).toMatchObject({ status: 'investigating', knownErrorAt: null, resolvedAt: null, closedAt: null });

    const refused = await patch({ status: 'known_error' });
    expect(refused.status).toBe(409);
    expect(await reason(refused)).toBe('workaround_required');
    expect((await problemRow('dprob_u1'))?.status).toBe('investigating');

    const known = await data(await patch({ status: 'known_error', workaround: 'Clear the cache' }));
    expect(known.status).toBe('known_error');
    expect(known.knownErrorAt).not.toBeNull();
    expect(known.resolvedAt).toBeNull();
    const knownAt = known.knownErrorAt;

    const resolved = await data(await patch({ status: 'resolved', resolution: 'Fixed in 2.4' }));
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.knownErrorAt).toBe(knownAt);
    expect(resolved.closedAt).toBeNull();

    const closed = await data(await patch({ status: 'closed' }));
    expect(closed.closedAt).not.toBeNull();
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);

    const back = await data(await patch({ status: 'known_error' }));
    expect(back).toMatchObject({ status: 'known_error', resolvedAt: null, closedAt: null, knownErrorAt: knownAt });

    expect(await data(await patch({ status: 'open' }))).toMatchObject({ status: 'open', knownErrorAt: null, resolvedAt: null, closedAt: null });
  });

  it('closing a problem that was never resolved sets both timestamps', async () => {
    await seedProblem('dprob_u2', 22, { title: 'Straight to closed' });
    const { data } = (await (await writer().request(`${BASE}/dprob_u2`, send({ status: 'closed' }, 'PATCH'))).json()) as { data: Problem };
    expect(data.closedAt).not.toBeNull();
    expect(data.resolvedAt).toBe(data.closedAt);
  });

  it('edits the fields, clears a text with null, and publishes what changed', async () => {
    await seedProblem('dprob_u3', 23, { title: 'Editable', rootCause: 'Old cause', priority: 'low' });
    const before = eventsOf('desk_problem', 'updated').length;
    const res = await writer().request(`${BASE}/dprob_u3`, send({ title: ' Edited ', priority: 'urgent', rootCause: null, assigneeId: USER, departmentId: 'dept_a', description: 'More text' }, 'PATCH'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Problem };
    expect(data).toMatchObject({ title: 'Edited', priority: 'urgent', rootCause: null, assigneeId: USER, departmentId: 'dept_a' });
    const events = eventsOf('desk_problem', 'updated');
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      entityId: 'dprob_u3',
      data: { changes: { title: { from: 'Editable', to: 'Edited' }, priority: { from: 'low', to: 'urgent' }, rootCause: { from: 'Old cause', to: null } } },
    });
  });

  it('keeps a known error backed: the last workaround or root cause cannot be cleared', async () => {
    await seedProblem('dprob_u4', 24, { title: 'Backed', status: 'known_error', workaround: 'Only this', knownErrorAt: at(24) });
    const res = await writer().request(`${BASE}/dprob_u4`, send({ workaround: '' }, 'PATCH'));
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe('workaround_required');
  });

  it('publishes nothing when nothing changes, and validates', async () => {
    const before = eventsOf('desk_problem', 'updated').length;
    expect((await writer().request(`${BASE}/dprob_u3`, send({ priority: 'urgent' }, 'PATCH'))).status).toBe(200);
    expect(eventsOf('desk_problem', 'updated')).toHaveLength(before);
    expect((await writer().request(`${BASE}/dprob_u3`, send({}, 'PATCH'))).status).toBe(400);
    expect((await writer().request(`${BASE}/dprob_u3`, send({ status: 'nope' }, 'PATCH'))).status).toBe(400);
    expect((await writer().request(`${BASE}/dprob_u3`, send({ departmentId: 'dept_off' }, 'PATCH'))).status).toBe(400);
    expect((await writer().request(`${BASE}/dprob_nope`, send({ title: 'x' }, 'PATCH'))).status).toBe(404);
  });
});

describe('DELETE /api/desk/problems/:id', () => {
  it('deletes the problem and unlinks its incidents without timeline events', async () => {
    await seedProblem('dprob_d1', 31, { title: 'To delete' });
    await seedConversation('dconv_d1', 421, { visitorId: 'vis_d1', problemId: 'dprob_d1' });
    await seedConversation('dconv_d2', 422, { visitorId: 'vis_d2', problemId: 'dprob_d1', state: 'closed' });
    const res = await writer().request(`${BASE}/dprob_d1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await problemRow('dprob_d1')).toBeUndefined();
    expect((await conversation('dconv_d1')).problemId).toBeNull();
    expect((await conversation('dconv_d2')).problemId).toBeNull();
    expect(await messagesOf('dconv_d1')).toEqual([]);
    expect(eventsOf('desk_problem', 'deleted').at(-1)).toMatchObject({ entityId: 'dprob_d1' });
    expect((await writer().request(`${BASE}/dprob_d1`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /api/desk/problems/:id/share-workaround', () => {
  beforeAll(async () => {
    await seedProblem('dprob_w1', 41, { title: 'Checkout fails', status: 'known_error', workaround: 'Use PayPal instead', knownErrorAt: at(41) });
    await seedConversation('dconv_w1', 431, { visitorId: 'vis_w1', name: 'Wes' });
    // Already answered once, so a reply doesn't set its first response time from the wall clock.
    await seedConversation('dconv_w2', 432, {
      channel: 'email',
      email: 'bob@shop.test',
      name: 'Bob',
      title: 'Cannot pay',
      firstResponseAt: at(14),
      firstResponseSeconds: 1,
    });
    await db.insert(schema.deskMessages).values({
      id: 'dmsg_w2_1',
      conversationId: 'dconv_w2',
      createdAt: at(13),
      kind: 'message',
      authorType: 'visitor',
      body: 'Payment fails',
      metadata: { helpdeskAddress: 'support@acme.test', emailMessageId: 'in-w2@shop.test' },
    });
    await seedConversation('dconv_w3', 433, { visitorId: 'vis_w3', state: 'closed' });
    await seedConversation('dconv_w4', 434, { visitorId: 'vis_w4', mergedIntoId: 'dconv_w1' });
    await db.update(schema.deskConversations).set({ problemId: 'dprob_w1' }).where(eq(schema.deskConversations.visitorId, 'vis_w1'));
    for (const id of ['dconv_w2', 'dconv_w3', 'dconv_w4']) {
      await db.update(schema.deskConversations).set({ problemId: 'dprob_w1' }).where(eq(schema.deskConversations.id, id));
    }
    await seedProblem('dprob_w2', 42, { title: 'No workaround yet' });
    await seedProblem('dprob_w3', 43, { title: 'No open incidents', workaround: 'Wait it out' });
  });

  it('adds an internal note to every open incident, and nothing to closed or merged ones', async () => {
    const mail = createSendEmailStub();
    const res = await writer({ SEND_EMAIL: mail }).request(`${BASE}/dprob_w1/share-workaround`, send({ visibility: 'note' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ visibility: 'note', delivered: 2, skipped: 0, conversationIds: ['dconv_w1', 'dconv_w2'] });
    const [note] = await messagesOf('dconv_w1');
    expect(note).toMatchObject({ kind: 'note', authorType: 'agent', authorId: USER, body: 'Use PayPal instead', metadata: { problemId: 'dprob_w1' } });
    expect(isPublicDeskMessage(note!)).toBe(false);
    expect(await messagesOf('dconv_w3')).toEqual([]);
    expect(await messagesOf('dconv_w4')).toEqual([]);
    expect(mail.sent).toHaveLength(0);
  });

  it('replies with the edited text, emailing the email ticket', async () => {
    const mail = createSendEmailStub();
    const res = await writer({ SEND_EMAIL: mail }).request(`${BASE}/dprob_w1/share-workaround`, send({ visibility: 'reply', body: 'Please pay with PayPal for now.' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { delivered: number } }).data.delivered).toBe(2);
    const reply = (await messagesOf('dconv_w1')).at(-1)!;
    expect(reply).toMatchObject({ kind: 'message', authorType: 'agent', body: 'Please pay with PayPal for now.', metadata: { problemId: 'dprob_w1' } });
    expect(isPublicDeskMessage(reply)).toBe(true);
    expect((await conversation('dconv_w1')).lastMessagePreview).toBe('Please pay with PayPal for now.');
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ from: 'support@acme.test', to: 'bob@shop.test' });
    expect((await conversation('dconv_w3')).lastMessagePreview).toBeNull();
  });

  it('refuses when there is no text at all, and posts to nobody when nothing is open', async () => {
    const none = await writer().request(`${BASE}/dprob_w2/share-workaround`, send({ visibility: 'note' }));
    expect(none.status).toBe(409);
    expect(await reason(none)).toBe('workaround_required');
    const empty = await writer().request(`${BASE}/dprob_w3/share-workaround`, send({ visibility: 'reply' }));
    expect(((await empty.json()) as { data: { delivered: number } }).data.delivered).toBe(0);
    expect((await writer().request(`${BASE}/dprob_w1/share-workaround`, send({}))).status).toBe(400);
    expect((await writer().request(`${BASE}/dprob_nope/share-workaround`, send({ visibility: 'note' }))).status).toBe(404);
  });
});

describe('POST /api/desk/problems/:id/article', () => {
  it('creates a draft internal article from the problem and stores it on the problem', async () => {
    await seedProblem('dprob_a1', 51, { title: 'Checkout <fails>', description: 'The pay button does nothing', rootCause: 'Gateway timeout', workaround: 'Use PayPal' });
    await seedConversation('dconv_a1', 441, { visitorId: 'vis_a1', problemId: 'dprob_a1' });
    const res = await writer().request(`${BASE}/dprob_a1/article`, { method: 'POST' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Problem };
    expect(data.articleId).toMatch(/^art_/);
    const [article] = await db.select().from(schema.helpdeskArticles).where(eq(schema.helpdeskArticles.id, data.articleId!));
    expect(article).toMatchObject({ title: 'Checkout <fails>', status: 'draft', visibility: 'internal', isDraft: true, authorId: USER, relatedTickets: ['dconv_a1'] });
    expect(article?.content).toBe(
      '<h2>Symptoms</h2><p>The pay button does nothing</p><h2>Cause</h2><p>Gateway timeout</p><h2>Workaround</h2><p>Use PayPal</p>',
    );
    const drafted = eventsOf('helpdesk_article', 'created').at(-1);
    expect(drafted).toMatchObject({
      // As above: in conformance mode this is the TypeScript run's event, with that run's new id.
      entityId: conformanceTarget() ? expect.any(String) : data.articleId,
      data: { title: 'Checkout <fails>', status: 'draft', problemId: 'dprob_a1' },
    });
    expect(drafted!.entityId).toBe((drafted!.data as { id: string }).id);
    expect(eventsOf('desk_problem', 'updated').at(-1)).toMatchObject({ entityId: 'dprob_a1' });

    const again = await writer().request(`${BASE}/dprob_a1/article`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect(await reason(again)).toBe('article_exists');
  });

  it('writes a new one when the article it pointed at is gone, and 404s an unknown problem', async () => {
    await seedProblem('dprob_a2', 52, { title: 'Gone article', workaround: 'Retry', articleId: 'art_missing' });
    expect((await writer().request(`${BASE}/dprob_a2/article`, { method: 'POST' })).status).toBe(201);
    expect((await writer().request(`${BASE}/dprob_nope/article`, { method: 'POST' })).status).toBe(404);
  });
});

describe('response shapes', () => {
  it('match the shared schemas the clients and the Rust port are checked against', async () => {
    const json = async (res: Response) => ((await res.json()) as { data: unknown }).data as never;
    const list = (await (await reader().request(BASE)).json()) as { data: unknown[] };
    expect(list.data.length).toBeGreaterThan(0);
    for (const item of list.data) expect(deskProblemWithCountsSchema.parse(item)).toBeTruthy();
    expect(deskProblemWithCountsSchema.parse(await json(await reader().request(`${BASE}/dprob_s2`)))).toBeTruthy();
    const incidents = (await json(await reader().request(`${BASE}/dprob_s2/conversations`))) as unknown[];
    for (const incident of incidents) expect(deskProblemIncidentSchema.parse(incident)).toBeTruthy();
    const created = await writer().request(BASE, send({ title: 'Schema check' }));
    expect(deskProblemCreatedSchema.parse(await json(created))).toBeTruthy();
    const shared = await writer().request(`${BASE}/dprob_s2/share-workaround`, send({ visibility: 'note' }));
    expect(deskProblemShareSchema.parse(await json(shared))).toBeTruthy();
  });
});

describe('permissions', () => {
  it('answers 403 without the permission of each call', async () => {
    const status = async (keys: string[], path: string, init?: RequestInit) => (await app(keys).request(`${BASE}${path}`, init)).status;
    expect(await status([], '')).toBe(403);
    expect(await status([], '/dprob_s1')).toBe(403);
    expect(await status([], '/dprob_s1/conversations')).toBe(403);
    expect(await status(['problems:read'], '', send({ title: 'x' }))).toBe(403);
    expect(await status(['problems:read', 'problems:create'], '/dprob_s1', send({ title: 'x' }, 'PATCH'))).toBe(403);
    expect(await status(['problems:read', 'problems:update'], '/dprob_s1', { method: 'DELETE' })).toBe(403);
    expect(await status(['problems:read'], '/dprob_s1/share-workaround', send({ visibility: 'note' }))).toBe(403);
    expect(await status(['problems:read', 'problems:update'], '/dprob_s1/article', { method: 'POST' })).toBe(403);
    expect(await status(['problems:update', 'articles:create'], '/dprob_s1/article', { method: 'POST' })).toBe(403);
  });
});
