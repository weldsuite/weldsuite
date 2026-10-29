/**
 * `GET /api/people/recent-correspondents` under the mailbox store's
 * `object-only` mode (docs/plans/weldmail-mailbox-store-design.md, task D7):
 * the address list behind `accountId` must come from the mailbox store's
 * `recentAddresses` instead of a direct `mail_messages` query — Postgres has
 * no rows for that account at all in this mode — while the MAIL-003 access
 * check (`checkAccountAccess`) still runs unchanged against the tenant DB.
 *
 * `object-only` rather than `object`: in `object` mode Postgres is a
 * dual-write secondary applied via `waitUntil`, and with no real
 * `ExecutionContext` in this harness that write would be a detached,
 * unawaited promise — asserting "no Postgres row" right after ingest would
 * race it. `object-only` has no Postgres secondary at all, so seeding
 * directly into the fake mailbox object is deterministic.
 *
 * Mode is forced via a fixed-value `FLAGSHIP` double
 * (`@weldsuite/mail-domain/store/testing/object-mode`), the same shared
 * helper mail-api's and app-api's own object-mode route tests use.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { peopleRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { ObjectWorkspaceMailStore, type ObjectWorkspaceMailStoreEnv } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace, createFakeMailIndexEnv } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage } from '@weldsuite/mail-domain/store';
import { createMemoryKv, createFixedModeFlagship } from '@weldsuite/mail-domain/store/testing/object-mode';
import type { Env } from '../../types';

const { mailAccounts, people, workspaceMembers, mailMessages } = schema;

// `createTestApp`'s defaults — the route resolves the mailbox object ref from
// these, so seeding must use the exact same pair.
const WORKSPACE_ID = 'ws_test_default';
const CLERK_ORG_ID = 'org_test_default';

const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

let db: Database;
let sharedAccountId: string;
let privateAssignedId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await db.insert(workspaceMembers).values([
    { id: generateId('wm'), userId: ASSIGNEE, email: `${ASSIGNEE}@test.dev`, role: 'MEMBER' },
    { id: generateId('wm'), userId: MEMBER, email: `${MEMBER}@test.dev`, role: 'MEMBER' },
  ] as (typeof workspaceMembers.$inferInsert)[]);

  await db.insert(people).values({
    id: generateId('person'),
    displayName: 'Jane Correspondent',
    email: 'jane@example.com',
  });

  sharedAccountId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: sharedAccountId,
    name: 'Shared',
    email: `${sharedAccountId}@test.dev`,
    isShared: true,
  });

  privateAssignedId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: privateAssignedId,
    name: 'Private',
    email: `${privateAssignedId}@test.dev`,
    isShared: false,
    assignedUserIds: [ASSIGNEE],
  });
}, 60_000);

beforeEach(() => {
  __resetMailStoreModeCacheForTests();
});

function makeMailEnv(): Partial<Env> {
  const { namespace } = createFakeMailboxNamespace();
  return {
    FLAGSHIP: createFixedModeFlagship('object-only') as unknown as Env['FLAGSHIP'],
    WORKSPACE_CACHE: createMemoryKv(),
    MAILBOX_STORE: namespace,
    MAIL_STORAGE: createMemoryR2(),
    MAIL_INDEX: createFakeMailIndexEnv().MAIL_INDEX,
  };
}

let seq = 0;
function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  seq += 1;
  return {
    id: `msg_recent_${seq}`,
    source: 'inbound',
    rfcMessageId: `rfc-recent-${seq}@test.dev`,
    threadId: null,
    from: { email: 'jane@example.com', name: 'Jane' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Recent correspondent test',
    preview: 'Recent correspondent test',
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

/** Seeds one message directly into the fake mailbox object behind `mailEnv`, never Postgres. */
async function seedMessage(mailEnv: Partial<Env>, accountId: string, overrides: Partial<IngestMessage> = {}) {
  const store = new ObjectWorkspaceMailStore(mailEnv as ObjectWorkspaceMailStoreEnv, WORKSPACE_ID, CLERK_ORG_ID);
  await store.mailbox(accountId).apply({ kind: 'ingest', message: makeIngest(overrides) });
}

function makeApp(userId: string, mailEnv: Partial<Env>) {
  return createTestApp('/api/people', peopleRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('people:read') },
    env: mailEnv,
  });
}

describe('GET /api/people/recent-correspondents (object-only mode)', () => {
  it("answers from the mailbox store, with no Postgres row behind it", async () => {
    const mailEnv = makeMailEnv();
    await seedMessage(mailEnv, sharedAccountId);

    const pgRows = await db.select().from(mailMessages).where(eq(mailMessages.accountId, sharedAccountId));
    expect(pgRows).toEqual([]);

    const { request } = makeApp(MEMBER, mailEnv);
    const res = await request(`/api/people/recent-correspondents?accountId=${sharedAccountId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ email: string | null }> };
    expect(body.data.map((p) => p.email)).toContain('jane@example.com');
  });

  it('still refuses a member who is not assigned to a private mailbox (MAIL-003 unchanged)', async () => {
    const mailEnv = makeMailEnv();
    await seedMessage(mailEnv, privateAssignedId);

    const { request } = makeApp(MEMBER, mailEnv);
    const res = await request(`/api/people/recent-correspondents?accountId=${privateAssignedId}`);
    expect(res.status).toBe(403);
  });

  it("answers the assignee of a private mailbox from the store", async () => {
    const mailEnv = makeMailEnv();
    await seedMessage(mailEnv, privateAssignedId);

    const { request } = makeApp(ASSIGNEE, mailEnv);
    const res = await request(`/api/people/recent-correspondents?accountId=${privateAssignedId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ email: string | null }> };
    expect(body.data.map((p) => p.email)).toContain('jane@example.com');
  });
});
