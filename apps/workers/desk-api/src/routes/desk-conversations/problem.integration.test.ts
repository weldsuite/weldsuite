/**
 * The problem on an incident on pglite: linking, replacing and unlinking with
 * internal timeline events, the refusals (a merged duplicate, a closed
 * problem), reading the linked problem, and what is published. Seeded rows
 * have fixed ids and timestamps, so the suite runs against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../../types';
import { deskConversationsRoutes } from './index';
import { deskConversationProblemRoutes } from './problem';

vi.setConfig({ testTimeout: 120_000 });

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
const BASE = '/api/desk/conversations';

let db: Database;

const routes = new Hono<{ Bindings: Env; Variables: Variables }>()
  .route('/', deskConversationsRoutes)
  .route('/', deskConversationProblemRoutes);

const app = (keys: string[]) =>
  createTestApp(BASE, routes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: { DATABASE_URL_MASTER: undefined } as never,
  });
const reader = () => app(['conversations:read']);
const writer = () => app(['conversations:update']);

const send = (body: unknown, method = 'PUT'): RequestInit => ({
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

async function row(id: string) {
  const [found] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  return found!;
}

interface Change {
  data: {
    conversation: { id: string; problemId?: string | null };
    problem: { id: string; problemNumber: number; title: string; status: string; workaround: string | null; rootCause: string | null } | null;
    messages: DeskMessage[];
  };
}

const eventTypes = (messages: DeskMessage[]) => messages.map((m) => m.metadata?.eventType);
const reason = async (res: Response) => ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({ id: 'wm_agent', userId: USER, name: 'Ada Lovelace' });
  await seedProblem('dprob_a', 1, { title: 'Checkout fails', status: 'known_error', workaround: 'Use PayPal', rootCause: 'Gateway timeout', knownErrorAt: at(1) });
  await seedProblem('dprob_b', 2, { title: 'Slow search' });
  await seedProblem('dprob_done', 3, { title: 'Done and dusted', status: 'closed', resolvedAt: at(3), closedAt: at(3) });
  await seedConversation('dconv_1', 501, { visitorId: 'vis_1', name: 'Pat' });
  await seedConversation('dconv_2', 502, { visitorId: 'vis_2', name: 'Quinn' });
  await seedConversation('dconv_dup', 503, { visitorId: 'vis_3', name: 'Remy', mergedIntoId: 'dconv_1' });
  await seedConversation('dconv_3', 504, { visitorId: 'vis_4', name: 'Sam' });
}, 60_000);

describe('GET /api/desk/conversations/:id/problem', () => {
  it('is null without a problem and 404s an unknown conversation', async () => {
    const res = await reader().request(`${BASE}/dconv_1/problem`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    expect((await reader().request(`${BASE}/dconv_nope/problem`)).status).toBe(404);
  });
});

describe('PUT /api/desk/conversations/:id/problem', () => {
  it('links a problem with an internal event, and the panel reads it back', async () => {
    const res = await writer().request(`${BASE}/dconv_1/problem`, send({ problemId: 'dprob_a' }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.problem).toEqual({ id: 'dprob_a', problemNumber: 1, title: 'Checkout fails', status: 'known_error', workaround: 'Use PayPal', rootCause: 'Gateway timeout' });
    expect(data.conversation.id).toBe('dconv_1');
    expect(eventTypes(data.messages)).toEqual(['problem_linked']);
    expect(data.messages[0]?.metadata).toMatchObject({ problemId: 'dprob_a', problemNumber: 1, problemTitle: 'Checkout fails' });
    expect(isPublicDeskMessage(data.messages[0]!)).toBe(false);
    expect((await row('dconv_1')).problemId).toBe('dprob_a');

    const read = (await (await reader().request(`${BASE}/dconv_1/problem`)).json()) as { data: { id: string; workaround: string } };
    expect(read.data).toMatchObject({ id: 'dprob_a', workaround: 'Use PayPal' });
  });

  it('publishes the conversation and the timeline entry', async () => {
    const updated = published.filter((e) => e.entityType === 'desk_conversation' && e.entityId === 'dconv_1' && e.action === 'updated');
    const created = published.filter((e) => e.entityType === 'desk_message' && e.action === 'created');
    expect(updated.length).toBeGreaterThanOrEqual(1);
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it('changes nothing when the problem is already linked', async () => {
    const { data } = (await (await writer().request(`${BASE}/dconv_1/problem`, send({ problemId: 'dprob_a' }))).json()) as Change;
    expect(data.messages).toEqual([]);
    expect(data.problem?.id).toBe('dprob_a');
  });

  it('replaces the problem with an unlinked event and then a linked one', async () => {
    const res = await writer().request(`${BASE}/dconv_1/problem`, send({ problemId: 'dprob_b' }));
    const { data } = (await res.json()) as Change;
    expect(eventTypes(data.messages)).toEqual(['problem_unlinked', 'problem_linked']);
    expect(data.messages[0]?.metadata).toMatchObject({ problemId: 'dprob_a', problemNumber: 1 });
    expect(data.messages[1]?.metadata).toMatchObject({ problemId: 'dprob_b', problemNumber: 2 });
    expect(data.problem?.id).toBe('dprob_b');
    expect((await row('dconv_1')).problemId).toBe('dprob_b');
  });

  it('unlinks, and a second unlink changes nothing', async () => {
    const { data } = (await (await writer().request(`${BASE}/dconv_1/problem`, send({ problemId: null }))).json()) as Change;
    expect(eventTypes(data.messages)).toEqual(['problem_unlinked']);
    expect(data.problem).toBeNull();
    expect((await row('dconv_1')).problemId).toBeNull();
    const again = (await (await writer().request(`${BASE}/dconv_1/problem`, send({ problemId: null }))).json()) as Change;
    expect(again.data.messages).toEqual([]);
  });

  it('refuses a merged duplicate and a closed problem', async () => {
    const merged = await writer().request(`${BASE}/dconv_dup/problem`, send({ problemId: 'dprob_a' }));
    expect(merged.status).toBe(409);
    expect(await reason(merged)).toBe('merged');
    const closed = await writer().request(`${BASE}/dconv_2/problem`, send({ problemId: 'dprob_done' }));
    expect(closed.status).toBe(409);
    expect(await reason(closed)).toBe('problem_closed');
    expect((await row('dconv_2')).problemId).toBeNull();
  });

  it('can still take a ticket off a problem that was closed since', async () => {
    await db.update(schema.deskConversations).set({ problemId: 'dprob_done' }).where(eq(schema.deskConversations.id, 'dconv_3'));
    const { data } = (await (await writer().request(`${BASE}/dconv_3/problem`, send({ problemId: null }))).json()) as Change;
    expect(eventTypes(data.messages)).toEqual(['problem_unlinked']);
  });

  it('404s an unknown conversation or problem, and validates the body', async () => {
    expect((await writer().request(`${BASE}/dconv_nope/problem`, send({ problemId: 'dprob_a' }))).status).toBe(404);
    expect((await writer().request(`${BASE}/dconv_2/problem`, send({ problemId: 'dprob_nope' }))).status).toBe(404);
    expect((await writer().request(`${BASE}/dconv_2/problem`, send({}))).status).toBe(400);
  });

  it('needs conversations:update to change and conversations:read to look', async () => {
    expect((await reader().request(`${BASE}/dconv_2/problem`, send({ problemId: 'dprob_a' }))).status).toBe(403);
    expect((await app([]).request(`${BASE}/dconv_2/problem`)).status).toBe(403);
  });
});
