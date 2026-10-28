/**
 * Object-mode coverage for the public mail API (design
 * docs/plans/weldmail-mailbox-store-design.md, task D5): the route code is
 * mode-agnostic (it only calls `store`/`access` from
 * `../lib/mail-store-context`), so these drive the REAL `getWorkspaceMail`
 * factory with `FLAGSHIP` pinned to `object` and the C2 fakes
 * (`@weldsuite/mail-domain/store/object/testing/fake-env`) for
 * `MAILBOX_STORE`/`MAIL_INDEX`, the same "fakes run the real
 * `MailboxStoreObject` class" approach `apps/workers/mail-api`'s own
 * object-mode tests use.
 *
 * In object mode, the mailbox object is the source of truth for its own
 * mailbox: a message must be `ingest`ed into the fake stub directly (there is
 * nothing to backfill from here), while `mail_accounts` rows still live in
 * Postgres — the KV mailbox directory's source (design §6) — so a workspace
 * key still only reaches a SHARED account, same as in `postgres` mode
 * (`mail.test.ts`'s own "workspace key" describe block).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import {
  createFakeMailboxNamespace,
  createFakeMailIndexEnv,
} from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { __resetMailRouterStateForTests } from '@weldsuite/mail-domain/store';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import type { ApiKeySession, Env } from '../types';

const { mailAccounts, workspaceMembers } = schema;

const ASSIGNEE = 'user_mail_object_assignee';
const WORKSPACE_ID = 'ws_mail_object';
const ORG_ID = 'org_mail_object';

let db: Database;
let sharedAccountId: string;
let privateAccountId: string;

/** A `FLAGSHIP` double that answers every flag lookup with `mode`, pinning `resolveMailStoreMode` without a real Flagship app. */
function createFixedModeFlagship(mode: string) {
  return { getStringValue: async () => mode };
}

function session(fields: Partial<ApiKeySession>): ApiKeySession {
  return {
    keyId: 'key_mail_object_test',
    keyType: 'workspace',
    workspaceId: WORKSPACE_ID,
    userId: null,
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    clerkOrgId: ORG_ID,
    licensedApps: null,
    ...fields,
  };
}

const workspaceKey = () => session({});
const personalKey = (userId: string) => session({ keyType: 'personal', userId });

function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  const id = overrides.id ?? generateId('mmsg');
  return {
    id,
    source: 'inbound',
    rfcMessageId: `${id}@test.dev`,
    threadId: null,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Object mode test',
    preview: 'preview',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    createdAt: Date.now(),
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    ...overrides,
  };
}

async function ingest(mailbox: ReturnType<typeof createFakeMailboxNamespace>, ref: MailboxRef, message: IngestMessage) {
  const ns = mailbox.namespace.jurisdiction('eu');
  const stub = ns.get(ns.idFromName(`mbx:${ref.workspaceId}:${ref.accountId}`));
  await stub.apply(ref, { kind: 'ingest', message }, message.sentAt);
}

function app(
  sess: ApiKeySession,
  mailbox: ReturnType<typeof createFakeMailboxNamespace>,
  mailIndex: ReturnType<typeof createFakeMailIndexEnv> = createFakeMailIndexEnv(),
) {
  return createExternalTestApp({
    session: sess,
    tenantDb: db,
    env: {
      FLAGSHIP: createFixedModeFlagship('object') as unknown as Env['FLAGSHIP'],
      WORKSPACE_CACHE: createMemoryKv() as unknown as Env['WORKSPACE_CACHE'],
      MAILBOX_STORE: mailbox.namespace,
      ...mailIndex,
      // `ObjectMailboxStore.getMessage` reads bodies from R2 directly
      // (bypassing the RPC), so it needs a working `.get()` even though these
      // tests never put a body in it.
      MAIL_STORAGE: createMemoryR2() as unknown as Env['MAIL_STORAGE'],
    } as Partial<Env>,
  }).request;
}

async function json<T = { data: unknown }>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: ASSIGNEE,
    email: `${ASSIGNEE}@test.dev`,
    role: 'MEMBER',
  } as typeof workspaceMembers.$inferInsert);

  sharedAccountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: sharedAccountId, name: 'Shared', email: `${sharedAccountId}@test.dev`, isShared: true });

  privateAccountId = generateId('mail');
  await db
    .insert(mailAccounts)
    .values({ id: privateAccountId, name: 'Private', email: `${privateAccountId}@test.dev`, isShared: false, assignedUserIds: [ASSIGNEE] });
}, 60_000);

beforeEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

afterEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

describe('object mode: GET /v1/mail-messages (main read path)', () => {
  it('lists a message ingested straight into the mailbox object', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: sharedAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const request = app(workspaceKey(), mailbox);
    const res = await request(`/v1/mail-messages?accountId=${sharedAccountId}`);
    expect(res.status).toBe(200);
    const body = await json<{ data: Array<{ id: string; threadKey?: string }> }>(res);
    expect(body.data.map((m) => m.id)).toContain(message.id);
    // `MailMessageListRow`'s internal `threadKey` must never reach the wire.
    for (const row of body.data) expect(row).not.toHaveProperty('threadKey');
  });

  it('a workspace key still reaches shared mailboxes only — a private mailbox is a 404', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const request = app(workspaceKey(), mailbox);
    expect((await request(`/v1/mail-messages/${message.id}`)).status).toBe(404);
    expect((await request(`/v1/mail-messages?accountId=${privateAccountId}`)).status).toBe(404);
    // The unified list (no accountId) must not leak the private message either.
    const unified = await json<{ data: Array<{ id: string }> }>(await request('/v1/mail-messages'));
    expect(unified.data.map((m) => m.id)).not.toContain(message.id);
  });

  it('the assignee reaches their private mailbox', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const request = app(personalKey(ASSIGNEE), mailbox);
    const res = await request(`/v1/mail-messages/${message.id}`);
    expect(res.status).toBe(200);
  });
});

describe('object mode: one organize op — PATCH /v1/mail-messages/:id', () => {
  it('flips isRead/isStarred through the store and the change is visible on re-read', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: sharedAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest({ isRead: false });
    await ingest(mailbox, ref, message);

    const request = app(workspaceKey(), mailbox);
    const patched = await request(`/v1/mail-messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true, isStarred: true }),
    });
    expect(patched.status).toBe(200);
    const body = await json<{ data: { isRead: boolean; isStarred: boolean; threadKey?: string } }>(patched);
    expect(body.data).toMatchObject({ isRead: true, isStarred: true });
    expect(body.data).not.toHaveProperty('threadKey');

    const reread = await json<{ data: { isRead: boolean } }>(await request(`/v1/mail-messages/${message.id}`));
    expect(reread.data.isRead).toBe(true);
  });
});
