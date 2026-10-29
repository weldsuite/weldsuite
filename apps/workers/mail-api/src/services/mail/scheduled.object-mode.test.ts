/**
 * Object-mode tests for scheduled mail's store wiring (design task D1):
 * create/cancel/reschedule go through a real `ObjectMailboxStore` (the C2
 * fakes, running the real `MailboxObject` class) instead of `mail_messages`
 * directly. `SEND_SCHEDULED_EMAIL` is a fake Workflow binding — the actual
 * send-at-scheduled-time path belongs to `send-scheduled-email.ts`'s own
 * Workflow tests.
 */

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { cancelScheduled, rescheduleScheduled, scheduleEmail } from './scheduled';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { ObjectMailboxStore } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import type { MailboxRef } from '@weldsuite/mail-domain/store/types';

const { mailAccounts } = schema;

const WORKSPACE_ID = 'ws_scheduled_object';
const ORG_ID = 'org_scheduled_object';
const USER = 'user_test';

let db: Database;

function storeFor(accountId: string): ObjectMailboxStore {
  const mailbox = createFakeMailboxNamespace();
  const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
  return new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
}

/** A `SEND_SCHEDULED_EMAIL` double: records every instance created, terminates on request. */
function fakeWorkflowBinding() {
  const instances = new Map<string, { terminated: boolean }>();
  const create = vi.fn(async ({ id }: { id: string; params: unknown }) => {
    instances.set(id, { terminated: false });
    return { id };
  });
  const get = vi.fn(async (id: string) => ({
    terminate: async () => {
      const instance = instances.get(id);
      if (instance) instance.terminated = true;
    },
  }));
  return { SEND_SCHEDULED_EMAIL: { create, get } as unknown as Env['SEND_SCHEDULED_EMAIL'], instances, create, get };
}

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: 'sender@test.dev', isShared: true });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('scheduled mail · object mode (store supplied)', () => {
  it('schedules through the store: the object holds a scheduled row, nothing lands in Postgres', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { SEND_SCHEDULED_EMAIL } = fakeWorkflowBinding();
    const env = { SEND_SCHEDULED_EMAIL } as unknown as Env;

    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const result = await scheduleEmail(env, db, ORG_ID, USER, { accountId, to: ['rcpt@example.com'], subject: 'Later', body: 'Body', scheduledFor }, store);

    const record = await store.getMessage(result.messageId);
    expect(record?.sendStatus).toBe('scheduled');
    expect(record?.labels).toEqual(expect.arrayContaining(['SENT', 'SCHEDULED']));
    expect(record?.triggerRunId).toBe(result.triggerRunId);

    const pgRows = await db
      .select({ id: schema.mailMessages.id })
      .from(schema.mailMessages)
      .where(eqAccount(accountId));
    expect(pgRows).toHaveLength(0);
  });

  it('cancels through the store: soft-deleted, no longer scheduled', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { SEND_SCHEDULED_EMAIL, get } = fakeWorkflowBinding();
    const env = { SEND_SCHEDULED_EMAIL } as unknown as Env;

    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await scheduleEmail(env, db, ORG_ID, USER, { accountId, to: ['rcpt@example.com'], subject: 'Later', body: 'Body', scheduledFor }, store);

    await cancelScheduled(env, db, scheduled.messageId, store);

    expect(get).toHaveBeenCalledWith(scheduled.triggerRunId);
    // Cancelling is a soft delete — same as the direct-Postgres path, a plain
    // read (`getMessage`, `listMessages`) no longer sees it at all.
    expect(await store.getMessage(scheduled.messageId)).toBeNull();
    const page = await store.listMessages({ limit: 10 });
    expect(page.data.map((m) => m.id)).not.toContain(scheduled.messageId);
  });

  it('a second cancel answers MESSAGE_NOT_FOUND (the first soft-deleted it)', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { SEND_SCHEDULED_EMAIL } = fakeWorkflowBinding();
    const env = { SEND_SCHEDULED_EMAIL } as unknown as Env;

    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await scheduleEmail(env, db, ORG_ID, USER, { accountId, to: ['rcpt@example.com'], subject: 'Later', body: 'Body', scheduledFor }, store);
    await cancelScheduled(env, db, scheduled.messageId, store);

    await expect(cancelScheduled(env, db, scheduled.messageId, store)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });

  it('reschedules through the store: new time, new workflow instance', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { SEND_SCHEDULED_EMAIL } = fakeWorkflowBinding();
    const env = { SEND_SCHEDULED_EMAIL } as unknown as Env;

    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await scheduleEmail(env, db, ORG_ID, USER, { accountId, to: ['rcpt@example.com'], subject: 'Later', body: 'Body', scheduledFor }, store);

    const newTime = new Date(Date.now() + 7_200_000);
    const rescheduled = await rescheduleScheduled(env, db, ORG_ID, USER, scheduled.messageId, newTime, store);
    expect(rescheduled.triggerRunId).not.toBe(scheduled.triggerRunId);

    const record = await store.getMessage(scheduled.messageId);
    expect(record?.sendStatus).toBe('scheduled');
    expect(record?.scheduledFor?.toISOString()).toBe(newTime.toISOString());
    expect(record?.triggerRunId).toBe(rescheduled.triggerRunId);
  });
});

function eqAccount(accountId: string) {
  return eq(schema.mailMessages.accountId, accountId);
}
