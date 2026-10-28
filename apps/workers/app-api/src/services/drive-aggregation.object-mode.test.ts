/**
 * `aggregateAllFiles`/`aggregateStats`'s mail attachment source under the
 * mailbox store's `object` mode (docs/plans/weldmail-mailbox-store-design.md,
 * task D6): list and count must come from `WorkspaceMailStore.
 * recentAttachments` (fanning out to the mailbox objects) instead of the
 * direct `mail_attachments` join, with the same access scoping
 * (`MailAccess.accessibleAccountIds()`, built from the KV directory off the
 * same `mail_accounts` rows a postgres-mode test seeds —
 * `./drive-aggregation.test.ts`) and the same authenticated download URL.
 *
 * `mail` is resolved via `getWorkspaceMail`'s own `mode` override (`store/
 * index.ts`'s `GetWorkspaceMailOptions.mode`, documented for exactly this: "a
 * caller that already knows the mode (tests, …)"), so no Flagship double is
 * needed here — these are pure functions with no Hono context at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { aggregateAllFiles, aggregateStats } from './drive-aggregation';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { getWorkspaceMail, type MailStoreEnv, type WorkspaceMail } from '@weldsuite/mail-domain/store';
import { createFakeMailboxNamespace, createFakeMailIndexEnv } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { createMemoryKv } from '../lib/testing/mail-object-mode';

const { mailAccounts, workspaceMembers } = schema;

const WORKSPACE_ID = 'ws_drive_object';
const CLERK_ORG_ID = 'org_drive_object';

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

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
  await seedMember(OWNER, 'OWNER');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  sharedAccountId = await seedAccount({ isShared: true });
  privateAssignedId = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassignedId = await seedAccount({ isShared: false, assignedUserIds: null });
}, 60_000);

function makeMailStoreEnv(): MailStoreEnv {
  const { namespace } = createFakeMailboxNamespace();
  return {
    MAILBOX_STORE: namespace,
    MAIL_STORAGE: createMemoryR2(),
    MAIL_INDEX: createFakeMailIndexEnv().MAIL_INDEX,
    WORKSPACE_CACHE: createMemoryKv(),
    ENVIRONMENT: 'test',
  } as MailStoreEnv;
}

async function mailFor(env: MailStoreEnv, userId: string, role: string): Promise<WorkspaceMail> {
  return getWorkspaceMail(env, {
    workspaceId: WORKSPACE_ID,
    clerkOrgId: CLERK_ORG_ID,
    db,
    waitUntil: (p) => {
      p.catch(() => {});
    },
    userId,
    role,
    mode: 'object',
  });
}

let seq = 0;
/** One message with one non-inline attachment named `fileName`, ingested through the mailbox store. */
async function seedAttachment(mail: WorkspaceMail, accountId: string, fileName: string) {
  seq += 1;
  const messageId = `msg_drive_${seq}`;
  const attachmentId = `matt_drive_${seq}`;
  await mail.store.mailbox(accountId).apply({
    kind: 'ingest',
    message: {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `rfc-drive-${seq}@test.dev`,
      threadId: null,
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Drive test',
      preview: 'Drive test',
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [{ id: attachmentId, messageId, fileName, size: 10, isInline: false }],
    },
  });
  return attachmentId;
}

async function mailFileNames(userId: string, role: string, env: MailStoreEnv): Promise<string[]> {
  const mail = await mailFor(env, userId, role);
  const files = await aggregateAllFiles(db, { userId, source: 'mail', mail });
  return files.map((f) => f.name).sort();
}

describe('aggregateAllFiles · mail attachments (object mode)', () => {
  it('lists only shared-mailbox attachments for an unassigned member', async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, MEMBER, 'MEMBER');
    await seedAttachment(mail, sharedAccountId, 'shared.pdf');
    await seedAttachment(mail, privateAssignedId, 'private.pdf');
    await seedAttachment(mail, privateUnassignedId, 'unassigned.pdf');

    expect(await mailFileNames(MEMBER, 'MEMBER', env)).toEqual(['shared.pdf']);
  });

  it('adds a private mailbox for its assignee', async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, ASSIGNEE, 'MEMBER');
    await seedAttachment(mail, sharedAccountId, 'shared.pdf');
    await seedAttachment(mail, privateAssignedId, 'private.pdf');
    await seedAttachment(mail, privateUnassignedId, 'unassigned.pdf');

    expect(await mailFileNames(ASSIGNEE, 'MEMBER', env)).toEqual(['private.pdf', 'shared.pdf']);
  });

  it("gives admins and owners the unassigned mailbox but not a colleague's private one", async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, ADMIN, 'ADMIN');
    await seedAttachment(mail, sharedAccountId, 'shared.pdf');
    await seedAttachment(mail, privateAssignedId, 'private.pdf');
    await seedAttachment(mail, privateUnassignedId, 'unassigned.pdf');

    expect(await mailFileNames(ADMIN, 'ADMIN', env)).toEqual(['shared.pdf', 'unassigned.pdf']);
    expect(await mailFileNames(OWNER, 'OWNER', env)).toEqual(['shared.pdf', 'unassigned.pdf']);
  });

  it('skips the mail query entirely for another source', async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, ASSIGNEE, 'MEMBER');
    await seedAttachment(mail, sharedAccountId, 'shared.pdf');

    const files = await aggregateAllFiles(db, { userId: ASSIGNEE, source: 'drive', mail });
    expect(files.filter((f) => f.source === 'mail')).toEqual([]);
  });

  it('points the download url at the authenticated route, never a raw storage url', async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, MEMBER, 'MEMBER');
    const attachmentId = await seedAttachment(mail, sharedAccountId, 'object-mode.pdf');

    const files = await aggregateAllFiles(db, {
      userId: MEMBER,
      source: 'mail',
      mail,
      apiOrigin: 'https://app-api.weldsuite.org',
    });
    const file = files.find((f) => f.id === attachmentId);
    expect(file).toBeDefined();
    expect(file?.url).toBe(`https://app-api.weldsuite.org/api/mail-attachments/${attachmentId}/download`);
  });
});

describe('aggregateStats · mail counter (object mode)', () => {
  it('counts what the feed would list, per caller', async () => {
    const env = makeMailStoreEnv();
    const mail = await mailFor(env, MEMBER, 'MEMBER');
    await seedAttachment(mail, sharedAccountId, 'shared.pdf');
    await seedAttachment(mail, privateAssignedId, 'private.pdf');

    const memberMail = await mailFor(env, MEMBER, 'MEMBER');
    const assigneeMail = await mailFor(env, ASSIGNEE, 'MEMBER');

    expect((await aggregateStats(db, MEMBER, undefined, memberMail)).bySource.mail).toBe(1);
    expect((await aggregateStats(db, ASSIGNEE, undefined, assigneeMail)).bySource.mail).toBe(2);
  });
});
