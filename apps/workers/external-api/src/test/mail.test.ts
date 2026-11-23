/**
 * WeldMail on the public API.
 *
 * What must hold, whatever the payload:
 *   - a workspace key or app token (no user) reaches shared mailboxes only, and
 *     everything in a private mailbox is a 404 — lists included;
 *   - a personal key follows its owner's WeldMail access;
 *   - every route is gated by its scope, and sending needs `mail_messages:send`
 *     by name (`*` and `mail_messages:*` do not grant it);
 *   - credential columns never appear in a response;
 *   - sends run under the API policies: verified sender domain, daily limit,
 *     idempotency, workspace-scoped uploads.
 *
 * Sends go through the real send path against a fake `SEND_EMAIL` binding that
 * records what it was given, with the MX lookups answered from a stub KV.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession, Env } from '../types';

// Carried on the session (as the auth middleware does), so no master-DB lookup
// and no module mock: the suite shares one module cache across files.
const ORG_ID = 'org_mail_test';

const { mailAccounts, mailMessages, mailDrafts, mailLabels, mailFolders, mailAttachments, mailDomains, workspaceMembers } =
  schema;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SECRET_COLUMNS = ['accessToken', 'refreshToken', 'apiKey', 'passwordHash'];

const ASSIGNEE = 'user_mail_assignee';
const OUTSIDER = 'user_mail_outsider';

let db: Database;
const ids = {
  shared: 'mail_t_shared',
  private: 'mail_t_private',
  gmail: 'mail_t_gmail',
  sharedMsg: 'msg_t_shared',
  privateMsg: 'msg_t_private',
  privateDraft: 'draft_t_private',
  privateLabel: 'label_t_private',
  privateFolder: 'mfld_t_private',
  privateAttachment: 'attach_t_private',
};

function session(fields: Partial<ApiKeySession>): ApiKeySession {
  return {
    keyId: 'key_mail_test',
    keyType: 'workspace',
    workspaceId: 'ws_test',
    userId: null,
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    clerkOrgId: ORG_ID,
    licensedApps: null,
    ...fields,
  };
}

const workspaceKey = (scopes: string[] = ['*', 'mail_messages:send']) => session({ scopes });
const personalKey = (userId: string, scopes: string[] = ['*', 'mail_messages:send']) =>
  session({ keyType: 'personal', userId, scopes });

/** Just enough of R2 for the upload + send + download paths. */
function memoryBucket() {
  const objects = new Map<string, { body: ArrayBuffer; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const view = (key: string) => {
    const o = objects.get(key)!;
    return {
      key,
      size: o.body.byteLength,
      uploaded: new Date(),
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      body: new Blob([o.body]).stream(),
      arrayBuffer: async () => o.body,
    };
  };
  return {
    objects,
    async put(key: string, body: ArrayBuffer | string, opts?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }) {
      const buf = typeof body === 'string' ? (new TextEncoder().encode(body).buffer as ArrayBuffer) : body;
      objects.set(key, { body: buf, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
      return view(key);
    },
    async get(key: string) {
      return objects.has(key) ? view(key) : null;
    },
    async head(key: string) {
      return objects.has(key) ? view(key) : null;
    },
    async list(opts: { prefix: string; limit?: number }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts.prefix)).slice(0, opts.limit ?? 1000);
      return { objects: keys.map(view), truncated: false };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function mailEnv() {
  const sent: { from: string; to: string }[] = [];
  const STORAGE = memoryBucket();
  const env: Partial<Env> = {
    // `sent` on the binding: conformance drops the TypeScript run's envelopes
    // from it, so the test counts the sends of the backend it checks.
    SEND_EMAIL: { sent, send: async (msg: { from: string; to: string }) => void sent.push(msg) } as unknown as SendEmail,
    // Every recipient domain resolves (cached MX hit), so no DNS is queried.
    // KV-shaped (`delete` too), so conformance serves it to the Rust backend.
    WORKSPACE_CACHE: {
      get: async () => '1',
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as KVNamespace,
    STORAGE: STORAGE as unknown as R2Bucket,
  };
  return { env, sent, STORAGE };
}

function app(sess: ApiKeySession | null, env?: Partial<Env>) {
  return createExternalTestApp({ session: sess, tenantDb: db, env }).request;
}

async function json<T = { data: Record<string, unknown> }>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seedAccount(id: string, email: string, fields: Partial<typeof mailAccounts.$inferInsert>) {
  await db.insert(mailAccounts).values({
    id,
    name: email,
    email,
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    apiKey: 'secret-key',
    passwordHash: 'secret-hash',
    ...fields,
  });
}

async function seedMessage(id: string, accountId: string, subject: string) {
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@example.com>`,
    from: { email: 'customer@example.com', name: 'Customer' },
    to: [{ email: 'team@mailtest.dev' }],
    subject,
    textBody: `${subject} body`,
    rawMessage: 'RAW SOURCE',
    labels: ['INBOX'],
    sentDate: new Date(),
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values([
    { id: 'wm_mail_assignee', userId: ASSIGNEE, email: 'assignee@mailtest.dev', role: 'MEMBER' },
    { id: 'wm_mail_outsider', userId: OUTSIDER, email: 'outsider@mailtest.dev', role: 'MEMBER' },
  ] as (typeof workspaceMembers.$inferInsert)[]);
  await db.insert(mailDomains).values({ id: 'mdom_t_verified', domainName: 'mailtest.dev', dnsStatus: 'verified' });

  await seedAccount(ids.shared, 'team@mailtest.dev', { isShared: true, dailySendLimit: 500 });
  await seedAccount(ids.private, 'alice@mailtest.dev', { isShared: false, assignedUserIds: [ASSIGNEE] });
  await seedAccount(ids.gmail, 'shared-gmail@gmail.com', { isShared: true });

  await seedMessage(ids.sharedMsg, ids.shared, 'Shared question');
  await seedMessage(ids.privateMsg, ids.private, 'Private matter');
  await db.insert(mailDrafts).values({ id: ids.privateDraft, accountId: ids.private, subject: 'private draft' });
  await db.insert(mailLabels).values({ id: ids.privateLabel, accountId: ids.private, name: 'Secret' });
  await db.insert(mailFolders).values({ id: ids.privateFolder, accountId: ids.private, name: 'Secret folder' });
  await db.insert(mailAttachments).values({
    id: ids.privateAttachment,
    messageId: ids.privateMsg,
    fileName: 'secret.pdf',
    size: 3,
    storagePath: `workspaces/${ORG_ID}/mail/secret.pdf`,
  });
}, 60_000);

// ---------------------------------------------------------------------------

describe('mailbox access · workspace key', () => {
  it('lists shared mailboxes only, with no credential columns', async () => {
    const res = await app(workspaceKey())('/v1/mail-accounts');
    expect(res.status).toBe(200);
    const body = await json<{ data: Record<string, unknown>[] }>(res);
    const accountIds = body.data.map((a) => a.id);
    expect(accountIds).toContain(ids.shared);
    expect(accountIds).not.toContain(ids.private);
    for (const row of body.data) for (const col of SECRET_COLUMNS) expect(row).not.toHaveProperty(col);
    expect(JSON.stringify(body)).not.toContain('secret-');
    const shared = body.data.find((a) => a.id === ids.shared)!;
    const gmail = body.data.find((a) => a.id === ids.gmail)!;
    expect(shared.canSendViaApi).toBe(true);
    expect(gmail.canSendViaApi).toBe(false);
  });

  it('answers 404 for anything in a private mailbox', async () => {
    const request = app(workspaceKey());
    const paths = [
      `/v1/mail-accounts/${ids.private}`,
      `/v1/mail-messages/${ids.privateMsg}`,
      `/v1/mail-messages/${ids.privateMsg}/attachments`,
      `/v1/mail-threads/${ids.privateMsg}?accountId=${ids.private}`,
      `/v1/mail-drafts/${ids.privateDraft}`,
      `/v1/mail-labels/${ids.privateLabel}`,
      `/v1/mail-folders/${ids.privateFolder}`,
      `/v1/mail-attachments/${ids.privateAttachment}`,
      `/v1/mail-attachments/${ids.privateAttachment}/download`,
      `/v1/mail-messages?accountId=${ids.private}`,
    ];
    for (const path of paths) {
      const res = await request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('keeps private mailboxes out of every list without an accountId', async () => {
    const request = app(workspaceKey());
    const lists = ['/v1/mail-messages', '/v1/mail-threads', '/v1/mail-drafts', '/v1/mail-labels', '/v1/mail-folders'];
    for (const path of lists) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      const body = await json<{ data: { accountId?: string }[] }>(res);
      expect(body.data.map((r) => r.accountId), path).not.toContain(ids.private);
    }
  });

  it('cannot change a private message', async () => {
    const request = app(workspaceKey());
    const patch = await request(`/v1/mail-messages/${ids.privateMsg}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ isRead: true }),
    });
    expect(patch.status).toBe(404);
    const bulk = await request('/v1/mail-messages/bulk', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ids: [ids.sharedMsg, ids.privateMsg], action: 'markRead' }),
    });
    expect(bulk.status).toBe(404);
    const [row] = await db.select({ isRead: mailMessages.isRead }).from(mailMessages).where(eq(mailMessages.id, ids.sharedMsg));
    expect(row?.isRead).toBe(false);
  });
});

describe('mailbox access · personal key', () => {
  it('the assignee reads their private mailbox; another member does not', async () => {
    const mine = await app(personalKey(ASSIGNEE))(`/v1/mail-messages/${ids.privateMsg}`);
    expect(mine.status).toBe(200);
    const msg = (await json(mine)).data;
    expect(msg.subject).toBe('Private matter');
    expect(msg).not.toHaveProperty('rawMessage');

    const theirs = await app(personalKey(OUTSIDER))(`/v1/mail-messages/${ids.privateMsg}`);
    expect(theirs.status).toBe(404);
  });
});

describe('scopes', () => {
  const cases: [string, string, RequestInit?][] = [
    ['/v1/mail-accounts', 'mail_accounts:read'],
    ['/v1/mail-messages', 'mail_messages:read'],
    ['/v1/mail-threads', 'mail_messages:read'],
    ['/v1/mail-labels', 'mail_labels:read'],
    ['/v1/mail-folders', 'mail_folders:read'],
    ['/v1/mail-drafts', 'mail_drafts:read'],
    [`/v1/mail-attachments/${ids.privateAttachment}`, 'mail_attachments:read'],
  ];
  for (const [path, scope] of cases) {
    it(`${path} needs ${scope}`, async () => {
      expect((await app(workspaceKey(['unrelated:read']))(path)).status).toBe(403);
      expect((await app(workspaceKey([scope]))(path)).status).not.toBe(403);
    });
  }

  it('organizing needs mail_messages:write', async () => {
    const res = await app(workspaceKey(['mail_messages:read']))(`/v1/mail-messages/${ids.sharedMsg}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ isStarred: true }),
    });
    expect(res.status).toBe(403);
  });

  it('sending needs mail_messages:send by name: write, * and mail_messages:* do not grant it', async () => {
    const send = (scopes: string[]) =>
      app(workspaceKey(scopes), mailEnv().env)(`/v1/mail-accounts/${ids.shared}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'x', body: 'y' }),
      });
    expect((await send(['mail_messages:write'])).status).toBe(403);
    expect((await send(['*'])).status).toBe(403);
    expect((await send(['mail_messages:*'])).status).toBe(403);
    expect((await send(['mail_messages:send'])).status).toBe(200);
  });
});

describe('organize', () => {
  it('flags, labels, moves and deletes a shared message', async () => {
    const request = app(workspaceKey());
    const id = 'msg_t_organize';
    await seedMessage(id, ids.shared, 'Organize me');

    const patched = await request(`/v1/mail-messages/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ isRead: true, isStarred: true }),
    });
    expect(patched.status).toBe(200);
    const patchedData = (await json(patched)).data;
    expect(patchedData).toMatchObject({ isRead: true, isStarred: true });
    // The raw attachment rows (with their storage paths) never come back.
    expect(patchedData).not.toHaveProperty('attachments');

    const labelled = await request(`/v1/mail-messages/${id}/labels`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ add: ['Invoices'] }),
    });
    expect((await json(labelled)).data.labels).toContain('Invoices');

    const wrongWay = await request(`/v1/mail-messages/${id}/labels`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ add: ['trash'] }),
    });
    expect(wrongWay.status).toBe(400);

    const moved = await request(`/v1/mail-messages/${id}/move`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ location: 'archive' }),
    });
    expect(moved.status).toBe(200);
    const [row] = await db.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, id));
    expect(row?.labels).toContain('ARCHIVE');
    expect(row?.labels).not.toContain('INBOX');

    expect((await request(`/v1/mail-messages/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/v1/mail-messages/${id}`)).status).toBe(404);
  });

  it('pages threads with an opaque cursor', async () => {
    const request = app(workspaceKey());
    await seedMessage('msg_t_thread_a', ids.shared, 'Thread A');
    await seedMessage('msg_t_thread_b', ids.shared, 'Thread B');
    const first = await json<{ data: { threadId: string }[]; pagination: { cursor: string | null; hasMore: boolean } }>(
      await request(`/v1/mail-threads?accountId=${ids.shared}&limit=1`),
    );
    expect(first.data).toHaveLength(1);
    expect(first.pagination.hasMore).toBe(true);
    const second = await json<{ data: { threadId: string }[] }>(
      await request(`/v1/mail-threads?accountId=${ids.shared}&limit=1&cursor=${first.pagination.cursor}`),
    );
    expect(second.data[0]?.threadId).not.toBe(first.data[0]?.threadId);
    expect((await request('/v1/mail-threads?cursor=not-a-cursor')).status).toBe(400);
  });
});

describe('sending', () => {
  it('sends from a shared mailbox on a verified domain', async () => {
    const { env, sent } = mailEnv();
    const res = await app(workspaceKey(), env)(`/v1/mail-accounts/${ids.shared}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Hello', body: 'Hi there' }),
    });
    expect(res.status).toBe(200);
    const data = (await json(res)).data;
    expect(data).toMatchObject({ accountId: ids.shared, subject: 'Hello', replayed: false });
    expect(sent.map((m) => m.to)).toEqual(['rcpt@example.com']);
  });

  it('refuses a sender on an unverified domain with 422', async () => {
    const { env, sent } = mailEnv();
    const res = await app(workspaceKey(), env)(`/v1/mail-accounts/${ids.gmail}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Hello', body: 'Hi' }),
    });
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('SENDER_DOMAIN_NOT_VERIFIED');
    expect(sent).toHaveLength(0);
  });

  it('a workspace key cannot send from a private mailbox', async () => {
    const { env } = mailEnv();
    const res = await app(workspaceKey(), env)(`/v1/mail-accounts/${ids.private}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Hello', body: 'Hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('replays a send with the same Idempotency-Key without sending twice', async () => {
    const { env, sent } = mailEnv();
    const request = app(workspaceKey(), env);
    const init = {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': 'idem-mail-1' },
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Once', body: 'Hi' }),
    };
    const first = (await json(await request(`/v1/mail-accounts/${ids.shared}/send`, init))).data;
    const second = (await json(await request(`/v1/mail-accounts/${ids.shared}/send`, init))).data;
    expect(second.messageId).toBe(first.messageId);
    expect(second.replayed).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('stops at the daily limit with 429 and Retry-After', async () => {
    const limited = 'mail_t_limited';
    await seedAccount(limited, 'limited@mailtest.dev', { isShared: true, dailySendLimit: 1 });
    const { env } = mailEnv();
    const request = app(workspaceKey(), env);
    const send = () =>
      request(`/v1/mail-accounts/${limited}/send`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Limit', body: 'Hi' }),
      });
    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe('DAILY_LIMIT_REACHED');
  });

  it('uploads a file and sends it; an upload id from another workspace is refused', async () => {
    const { env, STORAGE } = mailEnv();
    const request = app(workspaceKey(), env);
    const upload = await request('/v1/mail-attachments?filename=report.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'quarterly numbers',
    });
    expect(upload.status).toBe(201);
    const { id } = (await json<{ data: { id: string } }>(upload)).data;

    const res = await request(`/v1/mail-accounts/${ids.shared}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'With file', body: 'See attached', attachmentIds: [id] }),
    });
    expect(res.status).toBe(200);
    const { messageId } = (await json<{ data: { messageId: string } }>(res)).data;
    const files = await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, messageId));
    expect(files.map((f) => f.fileName)).toEqual(['report.txt']);

    // The same object under another org's prefix is not reachable by id.
    const [key] = [...STORAGE.objects.keys()];
    await STORAGE.put(key!.replace(`workspaces/${ORG_ID}/`, 'workspaces/org_other/'), 'x');
    STORAGE.objects.delete(key!);
    const crossed = await request(`/v1/mail-accounts/${ids.shared}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Crossed', body: 'x', attachmentIds: [id] }),
    });
    expect(crossed.status).toBe(422);
  });

  it('replies on the thread and sends a draft, deleting it', async () => {
    const { env, sent } = mailEnv();
    const request = app(workspaceKey(), env);
    const reply = await request(`/v1/mail-messages/${ids.sharedMsg}/reply`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'Thanks!' }),
    });
    expect(reply.status).toBe(200);
    expect((await json(reply)).data.repliedTo).toBe(ids.sharedMsg);
    expect(sent.map((m) => m.to)).toEqual(['customer@example.com']);

    const created = await request('/v1/mail-drafts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountId: ids.shared, to: ['rcpt@example.com'], subject: 'Drafted', body: 'Draft body' }),
    });
    expect(created.status).toBe(201);
    const draftId = (await json(created)).data.id as string;
    const sentDraft = await request(`/v1/mail-drafts/${draftId}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    });
    expect(sentDraft.status).toBe(200);
    expect((await request(`/v1/mail-drafts/${draftId}`)).status).toBe(404);
  });

  it('a retried draft send with the same Idempotency-Key replays instead of 404', async () => {
    const { env, sent } = mailEnv();
    const request = app(workspaceKey(), env);
    const created = await request('/v1/mail-drafts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountId: ids.shared, to: ['rcpt@example.com'], subject: 'Retry me', body: 'Hi' }),
    });
    const draftId = (await json(created)).data.id as string;
    const init = { method: 'POST', headers: { ...JSON_HEADERS, 'Idempotency-Key': 'idem-draft-1' }, body: '{}' };
    const first = (await json(await request(`/v1/mail-drafts/${draftId}/send`, init))).data;
    const retry = await request(`/v1/mail-drafts/${draftId}/send`, init);
    expect(retry.status).toBe(200);
    const second = (await json(retry)).data;
    expect(second).toMatchObject({ messageId: first.messageId, replayed: true });
    expect(sent).toHaveLength(1);
    // Without the key, the deleted draft is simply gone.
    expect((await request(`/v1/mail-drafts/${draftId}/send`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(404);
  });

  it('refuses a send without a body with 400', async () => {
    const { env, sent } = mailEnv();
    const res = await app(workspaceKey(), env)(`/v1/mail-accounts/${ids.shared}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'Subject only' }),
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('answers 503 when the send binding is missing', async () => {
    const res = await app(workspaceKey())(`/v1/mail-accounts/${ids.shared}/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['rcpt@example.com'], subject: 'No binding', body: 'x' }),
    });
    expect(res.status).toBe(503);
  });

  it('forwards a shared message to new recipients', async () => {
    const { env, sent } = mailEnv();
    const res = await app(workspaceKey(), env)(`/v1/mail-messages/${ids.sharedMsg}/forward`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: ['colleague@example.com'], body: 'FYI' }),
    });
    expect(res.status).toBe(200);
    const data = (await json(res)).data;
    expect(data).toMatchObject({ forwardedFrom: ids.sharedMsg, subject: 'Fwd: Shared question', replayed: false });
    expect(sent.map((m) => m.to)).toEqual(['colleague@example.com']);
  });
});

describe('organize mailboxes', () => {
  const post = (path: string, body: unknown) =>
    app(workspaceKey())(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) =>
    app(workspaceKey())(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const remove = (path: string) => app(workspaceKey())(path, { method: 'DELETE' });

  it('applies bulk actions to shared messages', async () => {
    await seedMessage('msg_t_bulk_a', ids.shared, 'Bulk A');
    await seedMessage('msg_t_bulk_b', ids.shared, 'Bulk B');
    const bulk = (action: string) => post('/v1/mail-messages/bulk', { ids: ['msg_t_bulk_a', 'msg_t_bulk_b'], action });
    for (const action of ['markRead', 'star', 'flag', 'archive']) {
      const res = await bulk(action);
      expect(res.status, action).toBe(200);
      expect((await json(res)).data).toEqual({ affected: 2, action });
    }
    const [row] = await db
      .select({ isRead: mailMessages.isRead, isFlagged: mailMessages.isFlagged, labels: mailMessages.labels })
      .from(mailMessages)
      .where(eq(mailMessages.id, 'msg_t_bulk_a'));
    expect(row).toMatchObject({ isRead: true, isFlagged: true });
    expect(row?.labels).toEqual(expect.arrayContaining(['STARRED', 'ARCHIVE']));
    expect((await bulk('delete')).status).toBe(200);
    expect((await app(workspaceKey())('/v1/mail-messages/msg_t_bulk_a')).status).toBe(404);
  });

  it('reads a thread, labels it and moves it by its labels', async () => {
    await seedMessage('msg_t_thread_c', ids.shared, 'Thread C');
    const read = await post('/v1/mail-threads/msg_t_thread_c/read', { accountId: ids.shared });
    expect(read.status).toBe(200);
    expect((await json(read)).data).toEqual({ threadId: 'msg_t_thread_c', accountId: ids.shared, isRead: true, updatedCount: 1 });

    const labelled = await post('/v1/mail-threads/msg_t_thread_c/labels', { accountId: ids.shared, add: ['Followup', 'archive'] });
    expect(labelled.status).toBe(200);
    expect((await json(labelled)).data).toEqual({ threadId: 'msg_t_thread_c', accountId: ids.shared, affected: 1 });

    const wrongWay = await post('/v1/mail-threads/msg_t_thread_c/labels', { accountId: ids.shared, remove: ['inbox'] });
    expect(wrongWay.status).toBe(400);

    const thread = await app(workspaceKey())(`/v1/mail-threads/msg_t_thread_c?accountId=${ids.shared}`);
    expect(thread.status).toBe(200);
    const messages = (await json<{ data: { messages: Record<string, unknown>[] } }>(thread)).data.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty('rawMessage');
    expect(messages[0]?.labels).toEqual(expect.arrayContaining(['Followup', 'ARCHIVE']));
  });

  it('creates, renames and deletes a label; a duplicate name is a conflict', async () => {
    const created = await post('/v1/mail-labels', { accountId: ids.shared, name: 'Receipts', color: '#4F46E5' });
    expect(created.status).toBe(201);
    const label = (await json(created)).data;
    expect(label).toMatchObject({ accountId: ids.shared, name: 'Receipts' });

    expect((await post('/v1/mail-labels', { accountId: ids.shared, name: 'receipts' })).status).toBe(409);
    expect((await post('/v1/mail-labels', { accountId: ids.shared, name: 'x', color: 'blue' })).status).toBe(400);

    const renamed = await patch(`/v1/mail-labels/${label.id as string}`, { name: 'Receipts 2026' });
    expect(renamed.status).toBe(200);
    expect((await json(renamed)).data).toMatchObject({ name: 'Receipts 2026' });

    expect((await remove(`/v1/mail-labels/${label.id as string}`)).status).toBe(204);
    expect((await app(workspaceKey())(`/v1/mail-labels/${label.id as string}`)).status).toBe(404);
  });

  it('creates, updates and deletes a folder, its parent in the same mailbox', async () => {
    const created = await post('/v1/mail-folders', { accountId: ids.shared, name: 'Projects', position: 3 });
    expect(created.status).toBe(201);
    const folder = (await json(created)).data;
    expect(folder).toMatchObject({ accountId: ids.shared, name: 'Projects', type: 'custom', position: 3 });

    const elsewhere = await post('/v1/mail-folders', { accountId: ids.shared, name: 'Child', parentId: ids.privateFolder });
    expect(elsewhere.status).toBe(400);
    const child = await post('/v1/mail-folders', { accountId: ids.shared, name: 'Child', parentId: folder.id });
    expect(child.status).toBe(201);

    const updated = await patch(`/v1/mail-folders/${folder.id as string}`, { color: '#22C55E', icon: 'folder' });
    expect(updated.status).toBe(200);
    expect((await json(updated)).data).toMatchObject({ color: '#22C55E', icon: 'folder' });
    expect((await patch(`/v1/mail-folders/${folder.id as string}`, {})).status).toBe(400);

    expect((await remove(`/v1/mail-folders/${folder.id as string}`)).status).toBe(204);
    expect((await app(workspaceKey())(`/v1/mail-folders/${folder.id as string}`)).status).toBe(404);
  });

  it('updates and deletes a draft; moving it needs the other mailbox too', async () => {
    const created = await post('/v1/mail-drafts', { accountId: ids.shared, subject: 'Draft one', inReplyTo: '<x@example.com>' });
    expect(created.status).toBe(201);
    const draft = (await json(created)).data;
    expect(draft).toMatchObject({ isReply: true, hasAttachments: false, attachmentCount: 0 });

    const updated = await patch(`/v1/mail-drafts/${draft.id as string}`, {
      subject: 'Draft two',
      to: ['rcpt@example.com'],
      attachmentIds: ['mupl_abcdefgh123'],
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).data).toMatchObject({
      subject: 'Draft two',
      to: ['rcpt@example.com'],
      hasAttachments: true,
      attachmentCount: 1,
    });
    expect((await patch(`/v1/mail-drafts/${draft.id as string}`, { accountId: ids.private })).status).toBe(404);

    expect((await remove(`/v1/mail-drafts/${draft.id as string}`)).status).toBe(204);
    expect((await app(workspaceKey())(`/v1/mail-drafts/${draft.id as string}`)).status).toBe(404);
  });

  it('lists and downloads a shared attachment', async () => {
    const { env, STORAGE } = mailEnv();
    await seedMessage('msg_t_with_file', ids.shared, 'With a file');
    await db.update(mailMessages).set({ hasAttachments: true, attachmentCount: 1 }).where(eq(mailMessages.id, 'msg_t_with_file'));
    const storagePath = `workspaces/${ORG_ID}/mail/notes.txt`;
    await STORAGE.put(storagePath, 'meeting notes', { httpMetadata: { contentType: 'text/plain' } });
    await db.insert(mailAttachments).values({
      id: 'attach_t_shared',
      messageId: 'msg_t_with_file',
      fileName: 'notes.txt',
      contentType: 'text/plain',
      size: 13,
      storagePath,
    });
    const request = app(workspaceKey(), env);

    const listed = await request('/v1/mail-messages/msg_t_with_file/attachments');
    expect(listed.status).toBe(200);
    const files = (await json<{ data: Record<string, unknown>[] }>(listed)).data;
    expect(files.map((f) => f.fileName)).toEqual(['notes.txt']);
    expect(files[0]).not.toHaveProperty('storagePath');

    const message = (await json(await request('/v1/mail-messages/msg_t_with_file?includeHtml=false'))).data;
    expect((message.attachments as Record<string, unknown>[]).map((f) => f.id)).toEqual(['attach_t_shared']);

    const download = await request('/v1/mail-attachments/attach_t_shared/download');
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('filename="notes.txt"');
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await download.text()).toBe('meeting notes');
  });
});
