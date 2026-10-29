/**
 * `GET /api/dashboard/sidebar-badges` under the mailbox store's `object` mode
 * (docs/plans/weldmail-mailbox-store-design.md, task D6): the unread count
 * must come from the mailbox objects (via `WorkspaceMailStore.unreadBadge`)
 * instead of a direct `mail_messages` query, while the accessible-mailbox
 * scoping still comes from the KV directory, built off the same
 * `mail_accounts` rows a postgres-mode test seeds (`./sidebar-badges.test.ts`).
 *
 * Mode is forced via a fixed-value `FLAGSHIP` double
 * (`@weldsuite/mail-domain/store/testing/object-mode`), the same pattern
 * mail-api's own object-mode route tests use — `getWorkspaceMail` resolves the mode through
 * Flagship exactly as the real route does, nothing here calls `apply`/`apply
 * Batch` directly.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { dashboardRoutes } from './index';
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

const { mailAccounts, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

// `createTestApp`'s defaults — the dashboard route resolves the mailbox
// object ref from these, so seeding must use the exact same pair.
const WORKSPACE_ID = 'ws_test_default';
const CLERK_ORG_ID = 'org_test_default';

let db: Database;

async function seedMember(userId: string, role: string) {
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
}

async function seedAccount(values: Partial<typeof mailAccounts.$inferInsert>): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, ...values });
  return id;
}

let sharedAccountId: string;
let privateAssignedId: string;
let privateUnassignedId: string;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  sharedAccountId = await seedAccount({ isShared: true });
  privateAssignedId = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassignedId = await seedAccount({ isShared: false, assignedUserIds: null });
}, 60_000);

beforeEach(() => {
  __resetMailStoreModeCacheForTests();
});

function makeMailEnv(): Partial<Env> {
  const { namespace } = createFakeMailboxNamespace();
  return {
    FLAGSHIP: createFixedModeFlagship('object') as unknown as Env['FLAGSHIP'],
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
    id: `msg_badge_${seq}`,
    source: 'inbound',
    rfcMessageId: `rfc-badge-${seq}@test.dev`,
    threadId: null,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Badge test',
    preview: 'Badge test',
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

/** Seeds `count` unread messages directly into the fake mailbox object behind `mailEnv`. */
async function seedUnread(mailEnv: Partial<Env>, accountId: string, count: number, overrides: Partial<IngestMessage> = {}) {
  const store = new ObjectWorkspaceMailStore(mailEnv as ObjectWorkspaceMailStoreEnv, WORKSPACE_ID, CLERK_ORG_ID);
  const mailbox = store.mailbox(accountId);
  for (let i = 0; i < count; i++) {
    await mailbox.apply({ kind: 'ingest', message: makeIngest(overrides) });
  }
}

async function unreadBadge(userId: string, mailEnv: Partial<Env>, isAdmin = false): Promise<number> {
  // The dashboard's sidebar badge has no `requirePermission` gate of its own
  // (unlike drive, which resolves the real role from `requirePermission`), so
  // `workspaceMailFromContext` falls back to a live permissions lookup for
  // object mode's `isAdmin()` check. Pre-caching the right role here (as the
  // harness's `permissions()` helper lets a test do) keeps that deterministic
  // without a real resolver wired into the test harness — `isAdminRole` only
  // looks at the role string, so `permissions('*')`'s `role: 'admin'` is
  // exactly what an ADMIN/OWNER's real `requirePermission` resolution would
  // have cached.
  const { request } = createTestApp('/api/dashboard', dashboardRoutes, {
    context: { userId, tenantDb: db, permissions: isAdmin ? permissions('*') : permissions() },
    env: mailEnv,
  });
  const res = await request('/api/dashboard/sidebar-badges');
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { unreadMessages: number } };
  return json.data.unreadMessages;
}

describe('GET /api/dashboard/sidebar-badges · unreadMessages (object mode)', () => {
  it('counts only shared mailboxes for an unassigned member', async () => {
    const mailEnv = makeMailEnv();
    await seedUnread(mailEnv, sharedAccountId, 1);
    expect(await unreadBadge(MEMBER, mailEnv)).toBe(1);
  });

  it('adds a private mailbox for its assignee', async () => {
    const mailEnv = makeMailEnv();
    await seedUnread(mailEnv, sharedAccountId, 1);
    await seedUnread(mailEnv, privateAssignedId, 2);
    expect(await unreadBadge(ASSIGNEE, mailEnv)).toBe(3);
  });

  it("gives an admin the unassigned mailbox but not a colleague's private one", async () => {
    const mailEnv = makeMailEnv();
    await seedUnread(mailEnv, sharedAccountId, 1);
    await seedUnread(mailEnv, privateAssignedId, 2);
    await seedUnread(mailEnv, privateUnassignedId, 4);
    expect(await unreadBadge(ADMIN, mailEnv, true)).toBe(5);
  });

  it('never counts unread mail already in the trash', async () => {
    const mailEnv = makeMailEnv();
    await seedUnread(mailEnv, sharedAccountId, 1);
    await seedUnread(mailEnv, sharedAccountId, 1, { labels: ['INBOX', 'TRASH'] });
    expect(await unreadBadge(MEMBER, mailEnv)).toBe(1);
  });
});
