/**
 * Object-mode coverage for the MCP server's copy of the mail routes (design
 * docs/plans/weldmail-mailbox-store-design.md, task D5): same route code as
 * external-api's `src/test/mail-object-mode.test.ts`, dispatched the way a
 * tool call actually reaches it — through `apiApp.fetch()` with an
 * `McpSession` — so this exercises `src/api/lib/mail-store-context.ts` and the
 * ported route files for real, not a hand-mocked seam.
 *
 * The one seam: the tenant DB is pglite, not a Neon connection (same pattern
 * `api/reach.test.ts` uses). `FLAGSHIP` is pinned to `object` and
 * `MAILBOX_STORE`/`MAIL_INDEX` are the C2 fakes
 * (`@weldsuite/mail-domain/store/object/testing/fake-env`).
 *
 * Unlike external-api, an MCP session is always a person (`McpSession` has no
 * "workspace key" concept — `src/api/types.ts`'s own doc comment: "Always
 * `personal` here: an OAuth token always represents a real user"), so the
 * "workspace key reaches shared mailboxes only" rule doesn't apply on this
 * surface; what's verified here instead is that a user only reaches the
 * mailboxes WeldMail would already give them (shared, or assigned).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateId } from '@weldsuite/worker-kit/id';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import {
  createFakeMailboxNamespace,
  createFakeMailIndexEnv,
} from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { __resetMailRouterStateForTests } from '@weldsuite/mail-domain/store';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import { mailAccounts, workspaceMembers } from '@weldsuite/db/schema';
import type { Database } from '@weldsuite/worker-kit/db';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';

// The one seam: the tenant DB is pglite, not a Neon connection.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db')>()),
  createTenantDb: () => holder.db,
}));

import { INTERNAL_ORIGIN, apiApp, internalEnv } from './app';

const ASSIGNEE = 'user_mcp_mail_object_assignee';
const WORKSPACE_ID = 'ws_mcp_mail_object';
const ORG_ID = 'org_mcp_mail_object';

let db: Database;
let sharedAccountId: string;
let privateAccountId: string;

function createFixedModeFlagship(mode: string) {
  return { getStringValue: async () => mode };
}

function session(userId: string): McpSession {
  return {
    tokenId: `tok_${userId}`,
    userId,
    clerkOrgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Object mode test',
    tier: 'enterprise',
    databaseUrl: 'postgresql://unused.invalid/db',
    permissions: ['*'],
    permissionDenies: [],
    role: 'ADMIN',
    clientId: null,
    licensedApps: null,
  };
}

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

function world(mailbox: ReturnType<typeof createFakeMailboxNamespace>, mailIndex = createFakeMailIndexEnv()) {
  const env = {
    ENVIRONMENT: 'test',
    DATABASE_URL_MASTER: 'not a connection string',
    FLAGSHIP: createFixedModeFlagship('object') as unknown as Env['FLAGSHIP'],
    WORKSPACE_CACHE: createMemoryKv() as unknown as Env['WORKSPACE_CACHE'],
    MAILBOX_STORE: mailbox.namespace,
    ...mailIndex,
    MAIL_STORAGE: createMemoryR2() as unknown as Env['MAIL_STORAGE'],
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

  async function call(who: McpSession, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await apiApp.fetch(
      new Request(new URL(path, INTERNAL_ORIGIN).toString(), {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      internalEnv(env, who),
      ctx,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  return { call };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.db = db;
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: ASSIGNEE,
    email: `${ASSIGNEE}@test.dev`,
    role: 'MEMBER',
  } as typeof workspaceMembers.$inferInsert);
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: `${ASSIGNEE}_outsider`,
    email: `${ASSIGNEE}_outsider@test.dev`,
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

    const { call } = world(mailbox);
    const res = await call(session(ASSIGNEE), 'GET', `/v1/mail-messages?accountId=${sharedAccountId}`);
    expect(res.status).toBe(200);
    const rows = (res.body as { data: Array<{ id: string }> }).data;
    expect(rows.map((m) => m.id)).toContain(message.id);
    for (const row of rows) expect(row).not.toHaveProperty('threadKey');
  });

  it('a private mailbox is a 404 for someone not assigned to it', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { call } = world(mailbox);
    const outsider = `${ASSIGNEE}_outsider`;
    const res = await call(session(outsider), 'GET', `/v1/mail-messages/${message.id}`);
    expect(res.status).toBe(404);
  });

  it('the assignee reaches their private mailbox', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { call } = world(mailbox);
    const res = await call(session(ASSIGNEE), 'GET', `/v1/mail-messages/${message.id}`);
    expect(res.status).toBe(200);
  });
});

describe('object mode: one organize op — POST /v1/mail-messages/:id/labels', () => {
  it('adds a label through the store and it shows up on re-read', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: sharedAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { call } = world(mailbox);
    const who = session(ASSIGNEE);
    const labelled = await call(who, 'POST', `/v1/mail-messages/${message.id}/labels`, { add: ['Invoices'] });
    expect(labelled.status).toBe(200);
    expect((labelled.body as { data: { labels: string[] } }).data.labels).toContain('Invoices');

    const reread = await call(who, 'GET', `/v1/mail-messages/${message.id}`);
    expect((reread.body as { data: { labels: string[] | null } }).data.labels ?? []).toContain('Invoices');
  });
});
