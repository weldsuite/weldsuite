/**
 * Linked tickets on pglite: parent/child links and the one-level rule, major
 * incidents (the update to every open linked customer, closing the children
 * with the incident, unmarking), and merging duplicates of one customer, with
 * the customer's next message landing on the kept conversation. Seeded rows
 * have fixed ids and timestamps, so the suite runs against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { appendDeskMessage, isPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../../types';
import { deskConversationsRoutes } from './index';
import { deskConversationLinkRoutes } from './links';

vi.setConfig({ testTimeout: 120_000 });

const USER = 'user_test_default';
const BASE = '/api/desk/conversations';

let db: Database;

const routes = new Hono<{ Bindings: Env; Variables: Variables }>()
  .route('/', deskConversationsRoutes)
  .route('/', deskConversationLinkRoutes);

const app = (keys: string[], env: Record<string, unknown> = {}) =>
  createTestApp(BASE, routes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: { DATABASE_URL_MASTER: undefined, ...env } as never,
  });
const reader = () => app(['conversations:read']);
const writer = (env: Record<string, unknown> = {}) => app(['conversations:update'], env);

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
    ...values,
  });
}

async function row(id: string) {
  const [found] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  return found!;
}

interface Change {
  data: { conversation: { id: string; state: string; parentConversationId: string | null; isMajorIncident: boolean; mergedIntoId: string | null }; messages: DeskMessage[] };
}

const eventTypes = (messages: DeskMessage[]) => messages.map((m) => m.metadata?.eventType);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({ id: 'wm_agent', userId: USER, name: 'Ada Lovelace' });
  // One level of links.
  await seed('dconv_parent', 301, { visitorId: 'vis_p', name: 'Pat' });
  await seed('dconv_child', 302, { visitorId: 'vis_q', name: 'Quinn' });
  await seed('dconv_grand', 303, { visitorId: 'vis_r', name: 'Remy' });
  // A major incident and the customers it affects.
  await seed('dconv_inc', 311, { visitorId: 'vis_ops', name: 'Status page', title: 'Checkout is down' });
  await seed('dconv_c1', 312, { visitorId: 'vis_c1', name: 'Cleo' });
  await seed('dconv_c2', 313, { channel: 'email', email: 'bob@shop.test', name: 'Bob', title: 'Cannot pay' });
  await db.insert(schema.deskMessages).values({
    id: 'dmsg_c2_1',
    conversationId: 'dconv_c2',
    createdAt: at(13),
    kind: 'message',
    authorType: 'visitor',
    body: 'Payment fails',
    metadata: { helpdeskAddress: 'support@acme.test', emailMessageId: 'in-c2@shop.test' },
  });
  await seed('dconv_c3', 314, { visitorId: 'vis_c3', name: 'Cas', state: 'closed' });
  // Duplicates of one customer (same email, one verified on the visitor), and someone else.
  await db.insert(schema.deskVisitors).values({ id: 'vis_mo', createdAt: at(0), updatedAt: at(0), lastSeenAt: at(0), verifiedEmail: 'mo@example.test' });
  await seed('dconv_dup', 321, { visitorId: 'vis_mo', name: 'Mo' });
  await seed('dconv_keep', 322, { channel: 'email', email: 'MO@example.test', name: 'Mo', state: 'closed' });
  await seed('dconv_dup2', 323, { channel: 'email', email: 'mo@example.test', name: 'Mo' });
  await seed('dconv_other', 324, { visitorId: 'vis_zed', name: 'Zed' });
}, 60_000);

describe('GET /api/desk/conversations/:id/links', () => {
  it('lists nothing for a conversation without links and 404s an unknown one', async () => {
    const res = await reader().request(`${BASE}/dconv_other/links`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { parent: null, children: [], mergedInto: null, mergedFrom: [] } });
    expect((await reader().request(`${BASE}/dconv_nope/links`)).status).toBe(404);
  });
});

describe('PUT /api/desk/conversations/:id/parent', () => {
  it('links a child to a parent with an internal event on both', async () => {
    const res = await writer().request(`${BASE}/dconv_child/parent`, send({ parentId: 'dconv_parent' }, 'PUT'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation.parentConversationId).toBe('dconv_parent');
    expect(eventTypes(data.messages)).toEqual(['linked']);
    expect(data.messages[0]?.metadata).toMatchObject({ linkedConversationId: 'dconv_parent', linkedConversationNumber: 301, linkRole: 'parent' });
    expect(isPublicDeskMessage(data.messages[0]!)).toBe(false);

    const links = await reader().request(`${BASE}/dconv_parent/links`);
    const body = (await links.json()) as { data: { children: Array<{ id: string; conversationNumber: number; state: string; name: string | null }> } };
    expect(body.data.children).toEqual([expect.objectContaining({ id: 'dconv_child', conversationNumber: 302, state: 'open', name: 'Quinn' })]);
    const childLinks = (await (await reader().request(`${BASE}/dconv_child/links`)).json()) as { data: { parent: { id: string } } };
    expect(childLinks.data.parent.id).toBe('dconv_parent');
  });

  it('keeps links one level deep and refuses self-links', async () => {
    const refused = async (id: string, parentId: string, reason: string) => {
      const res = await writer().request(`${BASE}/${id}/parent`, send({ parentId }, 'PUT'));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(reason);
    };
    await refused('dconv_grand', 'dconv_child', 'parent_is_child');
    await refused('dconv_parent', 'dconv_grand', 'has_children');
    await refused('dconv_grand', 'dconv_grand', 'self');
    expect((await writer().request(`${BASE}/dconv_grand/parent`, send({ parentId: 'dconv_nope' }, 'PUT'))).status).toBe(404);
  });

  it('unlinks, and a second unlink changes nothing', async () => {
    const res = await writer().request(`${BASE}/dconv_child/parent`, send({ parentId: null }, 'PUT'));
    const { data } = (await res.json()) as Change;
    expect(data.conversation.parentConversationId).toBeNull();
    expect(eventTypes(data.messages)).toEqual(['unlinked']);
    const again = (await (await writer().request(`${BASE}/dconv_child/parent`, send({ parentId: null }, 'PUT'))).json()) as Change;
    expect(again.data.messages).toEqual([]);
  });

  it('validates the body and needs conversations:update', async () => {
    expect((await writer().request(`${BASE}/dconv_child/parent`, send({}, 'PUT'))).status).toBe(400);
    expect((await reader().request(`${BASE}/dconv_child/parent`, send({ parentId: 'dconv_parent' }, 'PUT'))).status).toBe(403);
  });
});

describe('major incidents', () => {
  it('marks an incident and links the affected customers to it', async () => {
    const res = await writer().request(`${BASE}/dconv_inc/major-incident`, send({ isMajorIncident: true }, 'PUT'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change;
    expect(data.conversation.isMajorIncident).toBe(true);
    expect(eventTypes(data.messages)).toEqual(['incident_marked']);
    for (const id of ['dconv_c1', 'dconv_c2', 'dconv_c3']) {
      expect((await writer().request(`${BASE}/${id}/parent`, send({ parentId: 'dconv_inc' }, 'PUT'))).status).toBe(200);
    }
  });

  it('refuses an incident as a child, and a child as an incident', async () => {
    const asChild = await writer().request(`${BASE}/dconv_inc/parent`, send({ parentId: 'dconv_other' }, 'PUT'));
    expect(asChild.status).toBe(409);
    const childIncident = await writer().request(`${BASE}/dconv_c1/major-incident`, send({ isMajorIncident: true }, 'PUT'));
    expect(childIncident.status).toBe(409);
    expect(((await childIncident.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('incident_child');
  });

  it('posts one update on the incident and each open child, emailing the email ticket', async () => {
    const mail = createSendEmailStub();
    const res = await writer({ SEND_EMAIL: mail }).request(`${BASE}/dconv_inc/incident-update`, send({ body: 'We are restoring checkout.' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { conversation: { id: string }; message: DeskMessage; delivered: number } };
    expect(data.delivered).toBe(2);
    expect(data.message).toMatchObject({ kind: 'message', authorType: 'agent', body: 'We are restoring checkout.', metadata: { incidentId: 'dconv_inc' } });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ from: 'support@acme.test', to: 'bob@shop.test' });
    expect((await row('dconv_c1')).lastMessagePreview).toBe('We are restoring checkout.');
    expect((await row('dconv_c3')).lastMessagePreview).toBeNull();
  });

  it('refuses an update on a conversation that is not an incident', async () => {
    const res = await writer().request(`${BASE}/dconv_other/incident-update`, send({ body: 'Hello' }));
    expect(res.status).toBe(409);
    expect((await writer().request(`${BASE}/dconv_inc/incident-update`, send({ body: '  ' }))).status).toBe(400);
  });

  it('closes its open children with it when asked', async () => {
    const res = await writer().request(`${BASE}/dconv_inc/manage`, send({ action: 'close', closeChildren: true }));
    expect(res.status).toBe(200);
    expect((await row('dconv_inc')).state).toBe('closed');
    expect((await row('dconv_c1')).state).toBe('closed');
    expect((await row('dconv_c2')).state).toBe('closed');
  });

  it('unlinks the children when it is unmarked', async () => {
    const res = await writer().request(`${BASE}/dconv_inc/major-incident`, send({ isMajorIncident: false }, 'PUT'));
    const { data } = (await res.json()) as Change;
    expect(data.conversation.isMajorIncident).toBe(false);
    expect(eventTypes(data.messages)).toEqual(['incident_unmarked']);
    expect(data.messages[0]?.metadata?.unlinkedCount).toBe(3);
    for (const id of ['dconv_c1', 'dconv_c2', 'dconv_c3']) expect((await row(id)).parentConversationId).toBeNull();
  });
});

describe('POST /api/desk/conversations/:id/merge', () => {
  it('refuses tickets of different customers', async () => {
    const res = await writer().request(`${BASE}/dconv_dup/merge`, send({ targetId: 'dconv_other' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('different_customer');
  });

  it('merges a duplicate into the kept ticket of the same customer and closes it', async () => {
    const res = await writer().request(`${BASE}/dconv_dup/merge`, send({ targetId: 'dconv_keep' }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as Change & { data: { target: { id: string } } };
    expect(data.conversation).toMatchObject({ id: 'dconv_dup', state: 'closed', mergedIntoId: 'dconv_keep' });
    expect(data.target.id).toBe('dconv_keep');
    expect(eventTypes(data.messages)).toEqual(['merged_into', 'closed']);

    const links = (await (await reader().request(`${BASE}/dconv_keep/links`)).json()) as { data: { mergedFrom: Array<{ id: string }> } };
    expect(links.data.mergedFrom.map((m) => m.id)).toEqual(['dconv_dup']);
  });

  it('refuses merging twice, into a merged ticket, an incident or a parent', async () => {
    const reason = async (res: Response) => ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason;
    expect(await reason(await writer().request(`${BASE}/dconv_dup/merge`, send({ targetId: 'dconv_keep' })))).toBe('merged');
    expect(await reason(await writer().request(`${BASE}/dconv_dup2/merge`, send({ targetId: 'dconv_dup' })))).toBe('target_merged');
    expect(await reason(await writer().request(`${BASE}/dconv_dup2/merge`, send({ targetId: 'dconv_dup2' })))).toBe('self');
    expect((await writer().request(`${BASE}/dconv_dup2/merge`, send({ targetId: 'dconv_nope' }))).status).toBe(404);
    expect((await writer().request(`${BASE}/dconv_dup2/merge`, send({}))).status).toBe(400);
  });

  it("lands the customer's next message on the kept ticket, reopening it", async () => {
    expect((await row('dconv_keep')).state).toBe('closed');
    const result = await appendDeskMessage(db, {
      generateId,
      conversationId: 'dconv_dup',
      kind: 'message',
      authorType: 'visitor',
      authorId: 'vis_mo',
      body: 'Any news?',
    });
    expect(result.conversation.id).toBe('dconv_keep');
    expect(result.conversation.state).toBe('open');
    expect(result.message.conversationId).toBe('dconv_keep');
    expect((await row('dconv_dup')).state).toBe('closed');

    // An agent's note on the duplicate stays on the duplicate.
    const note = await appendDeskMessage(db, { generateId, conversationId: 'dconv_dup', kind: 'note', authorType: 'agent', authorId: USER, body: 'merged' });
    expect(note.conversation.id).toBe('dconv_dup');
  });
});
