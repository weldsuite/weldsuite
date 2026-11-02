/**
 * Every /api/desk/conversations route on pglite, refusals included: the inbox
 * list (filters, search, sorts, paging), the thread with its messages, agent
 * file uploads into the `STORAGE` bucket, replies and notes (messenger and
 * email, the outbound mail through a `SEND_EMAIL` stub) and the
 * close / reopen / assign actions. Conformance-ready: seeded rows have fixed
 * ids and timestamps, and the bucket is an R2-shaped memory bucket the
 * harness shares with the Rust backend.
 *
 * Assignments here go to the caller, to nobody, or to the agent who already
 * has the conversation, so no "assigned to you" notification goes out (the
 * notification helpers have their own tests).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskConversationsRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const USER = 'user_test_default';
const BASE = '/api/desk/conversations';
const R2_PUBLIC_URL = 'https://files.example.test/';
const PREFIX = 'https://files.example.test/desk/org_test_default';

let db: Database;
// One bucket for the whole file: the harness serves each bucket to Rust once.
const storage = createMemoryR2();

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function app(keys: string[], env: Record<string, unknown> = {}) {
  return createTestApp(BASE, deskConversationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: { STORAGE: storage, R2_PUBLIC_URL, ...env } as never,
  });
}

const reader = () => app(['conversations:read']);
const writer = (env: Record<string, unknown> = {}) => app(['conversations:update'], env);

async function seedConversation(
  id: string,
  conversationNumber: number,
  second: number,
  values: Partial<typeof schema.deskConversations.$inferInsert> = {},
) {
  await db.insert(schema.deskConversations).values({
    id,
    conversationNumber,
    createdAt: at(second),
    updatedAt: at(second),
    ...values,
  });
}

async function seedMessage(
  id: string,
  conversationId: string,
  second: number,
  values: Partial<typeof schema.deskMessages.$inferInsert> = {},
) {
  await db.insert(schema.deskMessages).values({
    id,
    conversationId,
    createdAt: at(second),
    kind: 'message',
    authorType: 'visitor',
    ...values,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_agent',
    userId: USER,
    name: 'Ada Lovelace',
    picture: 'https://img.example.test/ada.png',
  });

  await seedConversation('dconv_printer', 101, 1, {
    visitorId: 'vis_grace',
    name: 'Grace Hopper',
    email: 'Grace@Navy.test',
    waitingSince: at(10),
    lastMessageAt: at(11),
    lastMessagePreview: 'The printer shows error E42',
  });
  await seedMessage('dmsg_printer_1', 'dconv_printer', 10, { body: 'The printer shows error E42', authorId: 'vis_grace' });
  await seedMessage('dmsg_printer_2', 'dconv_printer', 11, {
    kind: 'note',
    authorType: 'agent',
    authorId: USER,
    body: 'Internal: check the toner first',
  });

  await seedConversation('dconv_invoice', 102, 2, {
    channel: 'phone',
    visitorId: 'vis_alan',
    name: 'Alan Turing',
    email: 'alan@bletchley.test',
    assigneeId: 'user_other',
    waitingSince: at(5),
    lastMessageAt: at(20),
    lastMessagePreview: 'Question about my invoice',
  });
  await seedMessage('dmsg_invoice_1', 'dconv_invoice', 20, { body: 'Question about my invoice', authorId: 'vis_alan' });

  await seedConversation('dconv_closed', 103, 3, {
    state: 'closed',
    name: 'Rita Levi',
    assigneeId: USER,
    lastMessageAt: at(15),
    lastMessagePreview: 'Thanks, all sorted',
  });
  await seedMessage('dmsg_closed_1', 'dconv_closed', 15, { body: 'Thanks, all sorted' });

  await seedConversation('dconv_email', 104, 4, {
    channel: 'email',
    title: 'Order 1234 never arrived',
    name: 'Shop Customer',
    email: 'customer@shop.test',
    waitingSince: at(30),
    lastMessageAt: at(30),
    lastMessagePreview: 'Where is my order?',
  });
  await seedMessage('dmsg_email_1', 'dconv_email', 30, {
    body: 'Where is my order?',
    metadata: { helpdeskAddress: 'support@acme.test', emailMessageId: 'in-1@shop.test' },
  });

  await seedConversation('dconv_email_noaddr', 105, 5, {
    channel: 'email',
    email: 'other@shop.test',
    name: '100% sure_thing',
  });
}, 60_000);

type Row = { id: string };
const ids = async (res: Response) => ((await res.json()) as { data: Row[] }).data.map((r) => r.id);

describe('GET /api/desk/conversations', () => {
  it('lists newest first by last activity, with pagination', async () => {
    const res = await reader().request(BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; lastMessagePreview: string | null }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data.map((r) => r.id)).toEqual([
      'dconv_email',
      'dconv_invoice',
      'dconv_closed',
      'dconv_printer',
      'dconv_email_noaddr',
    ]);
    expect(body.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
  });

  it('filters by state, assignee, channel, visitor and email', async () => {
    const { request } = reader();
    expect(await ids(await request(`${BASE}?state=closed`))).toEqual(['dconv_closed']);
    expect(await ids(await request(`${BASE}?state=open&assigneeId=user_other`))).toEqual(['dconv_invoice']);
    expect(await ids(await request(`${BASE}?unassigned=true&sort=oldest`))).toEqual([
      'dconv_printer',
      'dconv_email',
      'dconv_email_noaddr',
    ]);
    // "false" is no filter at all, as the Rust backend reads it.
    expect(await ids(await request(`${BASE}?unassigned=false&sort=oldest`))).toEqual(
      await ids(await request(`${BASE}?sort=oldest`)),
    );
    expect((await request(`${BASE}?unassigned=maybe`)).status).toBe(400);
    expect(await ids(await request(`${BASE}?channel=phone`))).toEqual(['dconv_invoice']);
    expect(await ids(await request(`${BASE}?channel=email&sort=oldest`))).toEqual(['dconv_email', 'dconv_email_noaddr']);
    expect(await ids(await request(`${BASE}?visitorId=vis_grace`))).toEqual(['dconv_printer']);
    expect(await ids(await request(`${BASE}?email=%20GRACE%40navy.test%20`))).toEqual(['dconv_printer']);
  });

  it('searches customer, subject, number and message text (notes too), literally', async () => {
    const { request } = reader();
    const search = async (q: string) => ids(await request(`${BASE}?q=${encodeURIComponent(q)}`));
    expect(await search('error e42')).toEqual(['dconv_printer']);
    expect(await search('TONER')).toEqual(['dconv_printer']);
    expect(await search('turing')).toEqual(['dconv_invoice']);
    expect(await search('order 1234')).toEqual(['dconv_email']);
    expect(await search('#103')).toEqual(['dconv_closed']);
    expect(await search('104')).toEqual(['dconv_email']);
    expect(await search('100%')).toEqual(['dconv_email_noaddr']);
    expect(await search('%')).toEqual(['dconv_email_noaddr']);
    expect(await search('e_42')).toEqual([]);
    expect(await search('   ')).toHaveLength(5);
  });

  it('sorts oldest first and longest waiting first', async () => {
    const { request } = reader();
    expect(await ids(await request(`${BASE}?sort=oldest`))).toEqual([
      'dconv_printer',
      'dconv_invoice',
      'dconv_closed',
      'dconv_email',
      'dconv_email_noaddr',
    ]);
    expect(await ids(await request(`${BASE}?sort=waiting_longest`))).toEqual([
      'dconv_invoice',
      'dconv_printer',
      'dconv_email',
      'dconv_closed',
      'dconv_email_noaddr',
    ]);
  });

  it('pages with an offset cursor', async () => {
    const { request } = reader();
    const first = await request(`${BASE}?sort=oldest&limit=2`);
    const page1 = (await first.json()) as { data: Row[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(page1.data.map((r) => r.id)).toEqual(['dconv_printer', 'dconv_invoice']);
    expect(page1.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: '2' });

    const last = await request(`${BASE}?sort=oldest&limit=2&cursor=4`);
    const page3 = (await last.json()) as { data: Row[]; pagination: { hasMore: boolean; cursor: string | null } };
    expect(page3.data.map((r) => r.id)).toEqual(['dconv_email_noaddr']);
    expect(page3.pagination).toMatchObject({ hasMore: false, cursor: null });

    // A cursor that isn't a number starts from the top.
    expect(await ids(await request(`${BASE}?sort=oldest&limit=1&cursor=abc`))).toEqual(['dconv_printer']);
  });

  it.each([
    ['a zero limit', 'limit=0'],
    ['a limit over 100', 'limit=101'],
    ['an unknown state', 'state=pending'],
    ['an unknown channel', 'channel=fax'],
    ['an unknown sort', 'sort=random'],
  ])('rejects %s', async (_label, query) => {
    expect((await reader().request(`${BASE}?${query}`)).status).toBe(400);
  });

  it('needs conversations:read', async () => {
    expect((await app([]).request(BASE)).status).toBe(403);
    expect((await writer().request(BASE)).status).toBe(403);
  });
});

describe('GET /api/desk/conversations/:id', () => {
  it('returns the conversation, and its timeline with ?include=messages', async () => {
    const { request } = reader();
    const plain = await request(`${BASE}/dconv_printer`);
    expect(plain.status).toBe(200);
    const conversation = ((await plain.json()) as { data: Record<string, unknown> }).data;
    expect(conversation).toMatchObject({ id: 'dconv_printer', conversationNumber: 101, state: 'open', channel: 'messenger' });
    expect(conversation).not.toHaveProperty('messages');

    const full = await request(`${BASE}/dconv_printer?include=messages`);
    expect(full.status).toBe(200);
    const body = (await full.json()) as { data: { id: string; messages: Array<{ id: string; kind: string }> } };
    expect(body.data.id).toBe('dconv_printer');
    expect(body.data.messages.map((m) => [m.id, m.kind])).toEqual([
      ['dmsg_printer_1', 'message'],
      ['dmsg_printer_2', 'note'],
    ]);

    const empty = await request(`${BASE}/dconv_email_noaddr?include=messages`);
    expect(((await empty.json()) as { data: { messages: unknown[] } }).data.messages).toEqual([]);
  });

  it('404s an unknown conversation and 400s an unknown include', async () => {
    const { request } = reader();
    const missing = await request(`${BASE}/dconv_nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Conversation with ID 'dconv_nope' not found" },
    });
    expect((await request(`${BASE}/dconv_printer?include=events`)).status).toBe(400);
  });

  it('needs conversations:read', async () => {
    expect((await app([]).request(`${BASE}/dconv_printer`)).status).toBe(403);
  });
});

/** A multipart body with one `file` part. */
function upload(content: string | Uint8Array, name: string, type?: string): RequestInit {
  const form = new FormData();
  form.append('file', new File([content], name, type === undefined ? undefined : { type }));
  return { method: 'POST', body: form };
}

interface Attachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
}

describe('POST /api/desk/conversations/:id/attachments', () => {
  it('stores an allowed file under the conversation and answers its public URL', async () => {
    const res = await writer().request(`${BASE}/dconv_printer/attachments`, upload('step one\nstep two\n', '📎 fix steps (v2).txt', 'text/plain'));
    expect(res.status).toBe(201);
    const attachment = ((await res.json()) as { data: Attachment }).data;
    expect(attachment.name).toBe('📎 fix steps (v2).txt');
    expect(attachment.contentType).toBe('text/plain');
    expect(attachment.filesize).toBe(18);
    // Each UTF-16 unit outside [a-zA-Z0-9._-] becomes `_` (the emoji is two).
    expect(attachment.url).toMatch(
      new RegExp(String.raw`^${PREFIX}/dconv_printer/\d{13}_att_[0-9a-z]+____fix_steps__v2_\.txt$`),
    );
    const key = attachment.url.slice('https://files.example.test/'.length);
    const object = await storage.get(key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe('step one\nstep two\n');
    expect(object!.httpMetadata?.contentType).toBe('text/plain');
  });

  it('refuses script-capable, unknown and oversized files', async () => {
    const { request } = writer();
    const svg = await request(`${BASE}/dconv_printer/attachments`, upload('<svg/>', 'x.svg', 'image/svg+xml'));
    expect(svg.status).toBe(400);
    expect(await svg.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'File type not allowed: image/svg+xml' } });

    const html = await request(`${BASE}/dconv_printer/attachments`, upload('<p/>', 'x.html', 'text/html'));
    expect(html.status).toBe(400);

    const big = await request(
      `${BASE}/dconv_printer/attachments`,
      upload(new Uint8Array(10 * 1024 * 1024 + 1), 'big.pdf', 'application/pdf'),
    );
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'File too large (max 10 MB)' } });
  });

  it('refuses a request without a file', async () => {
    const { request } = writer();
    const text = new FormData();
    text.append('file', 'not a file');
    const asText = await request(`${BASE}/dconv_printer/attachments`, { method: 'POST', body: text });
    expect(asText.status).toBe(400);
    expect(await asText.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No file provided' } });

    const other = new FormData();
    other.append('document', new File(['x'], 'x.txt', { type: 'text/plain' }));
    expect((await request(`${BASE}/dconv_printer/attachments`, { method: 'POST', body: other })).status).toBe(400);

    const notMultipart = await request(`${BASE}/dconv_printer/attachments`, json({ file: 'x' }));
    expect(notMultipart.status).toBe(400);
    expect(await notMultipart.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Expected multipart form data with a file' },
    });
  });

  it('404s an unknown conversation', async () => {
    const res = await writer().request(`${BASE}/dconv_nope/attachments`, upload('x', 'x.txt', 'text/plain'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Conversation with ID 'dconv_nope' not found" } });
  });

  it('is unavailable without a bucket or a public URL', async () => {
    const noBucket = await writer({ STORAGE: undefined }).request(
      `${BASE}/dconv_printer/attachments`,
      upload('x', 'x.txt', 'text/plain'),
    );
    expect(noBucket.status).toBe(503);
    expect(await noBucket.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'File upload is not configured' } });
    // Checked before the conversation is looked up.
    const noUrl = await writer({ R2_PUBLIC_URL: undefined }).request(
      `${BASE}/dconv_nope/attachments`,
      upload('x', 'x.txt', 'text/plain'),
    );
    expect(noUrl.status).toBe(503);
  });

  it('needs conversations:update', async () => {
    expect((await reader().request(`${BASE}/dconv_printer/attachments`, upload('x', 'x.txt', 'text/plain'))).status).toBe(403);
  });
});

interface ReplyBody {
  data: {
    conversation: { id: string; state: string; waitingSince: string | null; lastMessagePreview: string | null; lastMessageAt: string | null };
    message: { kind: string; body: string | null; authorType: string; authorId: string | null; attachments: Attachment[] | null };
  };
}

describe('POST /api/desk/conversations/:id/reply', () => {
  it('replies as the agent, which takes the conversation off the waiting list', async () => {
    const res = await writer().request(`${BASE}/dconv_printer/reply`, json({ body: '  Try turning it off and on  ' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as ReplyBody;
    expect(data.message).toMatchObject({ kind: 'message', body: 'Try turning it off and on', authorType: 'agent', authorId: USER, attachments: null });
    expect(data.conversation).toMatchObject({ id: 'dconv_printer', state: 'open', waitingSince: null, lastMessagePreview: 'Try turning it off and on' });
  });

  it('adds an internal note without touching the preview', async () => {
    const res = await writer().request(`${BASE}/dconv_invoice/reply`, json({ kind: 'note', body: 'Billing knows about this' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as ReplyBody;
    expect(data.message).toMatchObject({ kind: 'note', body: 'Billing knows about this' });
    expect(data.conversation).toMatchObject({ lastMessagePreview: 'Question about my invoice', lastMessageAt: at(20).toISOString() });
    expect(data.conversation.waitingSince).toBe(at(5).toISOString());
  });

  it('leaves a closed conversation closed when the agent replies', async () => {
    const res = await writer().request(`${BASE}/dconv_closed/reply`, json({ body: 'One more thing' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as ReplyBody).data.conversation.state).toBe('closed');
  });

  it('sends a file uploaded to the conversation, with or without text', async () => {
    const { request } = writer();
    const uploaded = await request(`${BASE}/dconv_closed/attachments`, upload('%PDF-1.4', 'manual.pdf', 'application/pdf'));
    expect(uploaded.status).toBe(201);
    const attachment = ((await uploaded.json()) as { data: Attachment }).data;

    const res = await request(`${BASE}/dconv_closed/reply`, json({ attachments: [attachment] }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as ReplyBody;
    expect(data.message.body).toBeNull();
    expect(data.message.attachments).toEqual([attachment]);
    expect(data.conversation.lastMessagePreview).toBe('📎 manual.pdf');
  });

  it('emails a reply on an email conversation, attaching its files', async () => {
    const mail = createSendEmailStub();
    const { request } = writer({ SEND_EMAIL: mail, DATABASE_URL_MASTER: undefined });
    const uploaded = await request(`${BASE}/dconv_email/attachments`, upload('label', 'label.txt', 'text/plain'));
    const attachment = ((await uploaded.json()) as { data: Attachment }).data;

    const res = await request(`${BASE}/dconv_email/reply`, json({ body: 'It ships today.', attachments: [attachment] }));
    expect(res.status).toBe(201);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ from: 'support@acme.test', to: 'customer@shop.test' });
    expect(mail.sent[0]!.raw).toContain('In-Reply-To: in-1@shop.test');
    expect(mail.sent[0]!.raw).toContain('It ships today.');
    expect(mail.sent[0]!.raw).toContain('filename="label.txt"');

    // Notes stay internal: nothing is emailed.
    const note = await request(`${BASE}/dconv_email/reply`, json({ kind: 'note', body: 'Courier says Monday' }));
    expect(note.status).toBe(201);
    expect(mail.sent).toHaveLength(1);
  });

  it('stores the reply when the thread has no helpdesk address to send from', async () => {
    const mail = createSendEmailStub();
    const res = await writer({ SEND_EMAIL: mail, DATABASE_URL_MASTER: undefined }).request(
      `${BASE}/dconv_email_noaddr/reply`,
      json({ body: 'We are on it' }),
    );
    expect(res.status).toBe(201);
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses files that were not uploaded to this conversation', async () => {
    const { request } = writer();
    const file = (url: string) => ({ name: 'x.pdf', url, contentType: 'application/pdf', filesize: 1 });
    const refused = { error: { code: 'BAD_REQUEST', message: 'Attachments must be uploaded to this conversation first' } };
    for (const url of [
      'https://evil.test/x.pdf',
      `${PREFIX}/dconv_invoice/1767268800000_att_abc123_x.pdf`,
      `${PREFIX}/dconv_printer/x.pdf`,
      `${PREFIX}/dconv_printer/1767268800000_att_abc123_x.pdf?download=1`,
    ]) {
      const res = await request(`${BASE}/dconv_printer/reply`, json({ body: 'see attached', attachments: [file(url)] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(refused);
    }
    // Without a public URL no file can be ours. Checked before the conversation exists.
    const noUrl = await writer({ R2_PUBLIC_URL: undefined }).request(
      `${BASE}/dconv_nope/reply`,
      json({ attachments: [file(`${PREFIX}/dconv_nope/1767268800000_att_abc123_x.pdf`)] }),
    );
    expect(noUrl.status).toBe(400);
  });

  it.each([
    ['an empty reply', { body: '   ' }],
    ['no body at all', {}],
    ['an event', { kind: 'event', body: 'x' }],
    ['an attachment without a URL', { attachments: [{ name: 'x', url: 'nope', contentType: 'text/plain', filesize: 1 }] }],
    ['a negative file size', { attachments: [{ name: 'x', url: 'https://x.test/x', contentType: 'text/plain', filesize: -1 }] }],
  ])('rejects %s', async (_label, body) => {
    expect((await writer().request(`${BASE}/dconv_printer/reply`, json(body))).status).toBe(400);
  });

  it('404s an unknown conversation', async () => {
    const res = await writer().request(`${BASE}/dconv_nope/reply`, json({ body: 'hello?' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Conversation with ID 'dconv_nope' not found" } });
  });

  it('needs conversations:update', async () => {
    expect((await reader().request(`${BASE}/dconv_printer/reply`, json({ body: 'x' }))).status).toBe(403);
  });
});

interface ManageBody {
  data: {
    conversation: { id: string; state: string; assigneeId: string | null; waitingSince: string | null };
    message: { kind: string; authorType: string; authorId: string | null; metadata: Record<string, unknown> | null };
  };
}

describe('POST /api/desk/conversations/:id/manage', () => {
  const manage = (id: string, body: unknown) => writer().request(`${BASE}/${id}/manage`, json(body));

  it('closes and reopens a conversation, each with a timeline event', async () => {
    const closed = await manage('dconv_invoice', { action: 'close' });
    expect(closed.status).toBe(200);
    const close = (await closed.json()) as ManageBody;
    expect(close.data.conversation).toMatchObject({ state: 'closed', waitingSince: null, assigneeId: 'user_other' });
    expect(close.data.message).toMatchObject({
      kind: 'event',
      authorType: 'agent',
      authorId: USER,
      metadata: { eventType: 'closed', assigneeId: null },
    });

    const reopened = await manage('dconv_invoice', { action: 'open' });
    expect(reopened.status).toBe(200);
    const open = (await reopened.json()) as ManageBody;
    expect(open.data.conversation.state).toBe('open');
    expect(open.data.message.metadata).toEqual({ eventType: 'reopened', assigneeId: null });
  });

  it('assigns, re-assigns the same agent and unassigns', async () => {
    const mine = await manage('dconv_printer', { action: 'assign', assigneeId: USER });
    expect(mine.status).toBe(200);
    const assigned = (await mine.json()) as ManageBody;
    expect(assigned.data.conversation.assigneeId).toBe(USER);
    expect(assigned.data.message.metadata).toEqual({ eventType: 'assigned', assigneeId: USER });

    // Already theirs: no notification, still an event.
    const same = await manage('dconv_invoice', { action: 'assign', assigneeId: 'user_other' });
    expect(same.status).toBe(200);
    expect(((await same.json()) as ManageBody).data.conversation.assigneeId).toBe('user_other');

    for (const body of [{ action: 'assign', assigneeId: null }, { action: 'assign' }, { action: 'assign', assigneeId: '' }]) {
      const res = await manage('dconv_printer', body);
      expect(res.status).toBe(200);
      const unassigned = (await res.json()) as ManageBody;
      expect(unassigned.data.conversation.assigneeId).toBeNull();
      expect(unassigned.data.message.metadata).toEqual({ eventType: 'unassigned', assigneeId: null });
    }
  });

  it('shows the actions on the timeline', async () => {
    const res = await reader().request(`${BASE}/dconv_invoice?include=messages`);
    const body = (await res.json()) as { data: { messages: Array<{ kind: string; metadata: { eventType?: string } | null }> } };
    expect(body.data.messages.filter((m) => m.kind === 'event').map((m) => m.metadata?.eventType)).toEqual([
      'closed',
      'reopened',
      'assigned',
    ]);
    const [row] = await db
      .select({ state: schema.deskConversations.state })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, 'dconv_invoice'));
    expect(row!.state).toBe('open');
  });

  it.each([
    ['an unknown action', { action: 'archive' }],
    ['no action', {}],
    ['an over-long assignee', { action: 'assign', assigneeId: 'u'.repeat(256) }],
  ])('rejects %s', async (_label, body) => {
    expect((await manage('dconv_printer', body)).status).toBe(400);
  });

  it('404s an unknown conversation', async () => {
    const res = await manage('dconv_nope', { action: 'close' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Conversation with ID 'dconv_nope' not found" } });
  });

  it('needs conversations:update', async () => {
    expect((await reader().request(`${BASE}/dconv_printer/manage`, json({ action: 'close' }))).status).toBe(403);
  });
});
