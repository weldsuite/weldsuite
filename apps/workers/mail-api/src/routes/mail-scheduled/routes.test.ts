/**
 * /api/mail-scheduled against a pglite tenant DB (postgres mode), with a
 * SEND_SCHEDULED_EMAIL fake that answers by method and id, a SEND_EMAIL stub,
 * MX answers in a KV stub and attachments in a memory bucket: schedule,
 * list, reschedule, cancel and send now, with their refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailScheduledRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers, seedMessages } from '../../test/mail-seed';

let db: Database;
const storage = createMemoryR2();
const sendEmail = createSendEmailStub({ 'refused@x.com': 'E_RECIPIENT_SUPPRESSED' });
const KEY = 'workspaces/org_test_default/uploads/plan.txt';

/** The Workflow binding: every instance exists and stops on request. */
const workflow = {
  create: async (options: { id: string }) => ({ id: options.id }),
  get: async (id: string) => ({ id, terminate: async () => undefined, sendEvent: async () => undefined }),
};

const kv = {
  values: new Map<string, string>([
    ['mx:x.com', '1'],
    ['mx:example.com', '1'],
  ]),
  get: async (key: string) => kv.values.get(key) ?? null,
  put: async (key: string, value: string) => {
    kv.values.set(key, value);
  },
  delete: async (key: string) => {
    kv.values.delete(key);
  },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await storage.put(KEY, 'the plan', { httpMetadata: { contentType: 'text/plain' } });
  await seedMembers(db);
  await seedMailboxes(db);
  await seedMessages(db, [{ id: 'mmsg_sc_upload', subject: 'Holder' }]);
  await db.insert(schema.mailAttachments).values({
    id: 'attach_sc_upload',
    messageId: 'mmsg_sc_upload',
    fileName: 'upload.txt',
    size: 4,
    storagePath: KEY,
  } as never);
}, 60_000);

function as(userId: string, env: Record<string, unknown> = {}) {
  const { request } = createTestApp('/api/mail-scheduled', mailScheduledRoutes, {
    context: {
      userId,
      tenantDb: db,
      permissions: permissions('messages:read', 'messages:create', 'messages:update', 'messages:delete'),
    },
    env: { SEND_SCHEDULED_EMAIL: workflow, SEND_EMAIL: sendEmail, WORKSPACE_CACHE: kv, STORAGE: storage, ...env } as never,
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-scheduled${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function schedule(call: ReturnType<typeof as>, body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '', { accountId: SHARED, scheduledFor: inDays(1), ...body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { messageId: string } }).data.messageId;
}

describe('scheduled mail', () => {
  it('schedules, lists and refuses bad schedules', async () => {
    const member = as(MEMBER);
    await schedule(member, {
      to: ['anna@x.com'],
      cc: ['bob@x.com'],
      subject: 'Plan',
      body: 'See the plan',
      attachments: [{ filename: 'plan.txt', size: 8, fileKey: KEY }],
      attachmentIds: ['attach_sc_upload', 'attach_missing'],
      inReplyTo: '<root@x.com>',
      references: ['<root@x.com>'],
    });
    await schedule(member, { to: ['carl@example.com'], htmlBody: '<p>Hi</p>' });
    expect((await member('GET', '')).status).toBe(200);
    expect((await member('GET', `?accountId=${SHARED}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `?accountId=${PRIVATE}`)).status).toBe(403);

    expect((await member('POST', '', { accountId: SHARED, to: ['a@x.com'], scheduledFor: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await member('POST', '', { accountId: SHARED, to: ['a@x.com'], scheduledFor: inDays(400) })).status).toBe(400);
    expect((await member('POST', '', { accountId: SHARED, to: ['a@x.com'], scheduledFor: 'soon' })).status).toBe(400);
    expect((await member('POST', '', { accountId: SHARED, to: [], scheduledFor: inDays(1) })).status).toBe(400);
    expect((await as(STRANGER)('POST', '', { accountId: PRIVATE, to: ['a@x.com'], scheduledFor: inDays(1) })).status).toBe(403);
    const foreign = await member('POST', '', {
      accountId: SHARED,
      to: ['a@x.com'],
      scheduledFor: inDays(1),
      attachments: [{ filename: 'x', size: 1, fileKey: 'workspaces/org_other/x' }],
    });
    expect(foreign.status).toBe(400);
    expect((await as(MEMBER, { SEND_SCHEDULED_EMAIL: undefined })('POST', '', { accountId: SHARED, to: ['a@x.com'], scheduledFor: inDays(1) })).status).toBe(503);
  });

  it('reschedules, cancels and sends now', async () => {
    const member = as(MEMBER);
    const later = await schedule(member, { to: ['anna@x.com'], subject: 'Later' });
    expect((await member('POST', `/${later}/reschedule`, { scheduledFor: inDays(2) })).status).toBe(200);
    expect((await member('POST', `/${later}/reschedule`, { scheduledFor: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await member('POST', '/msg_missing/reschedule', { scheduledFor: inDays(2) })).status).toBe(404);

    const now = await schedule(member, { to: ['anna@x.com', 'bob@x.com'], subject: 'Now', body: 'Right away' });
    const sent = await member('POST', `/${now}/send-now`);
    expect(sent.status).toBe(200);
    expect((await member('POST', `/${now}/send-now`)).status).toBe(409);

    const partial = await schedule(member, { to: ['anna@x.com', 'refused@x.com'], subject: 'Partly' });
    expect((await member('POST', `/${partial}/send-now`)).status).toBe(200);

    expect((await member('POST', `/${later}/cancel`)).status).toBe(200);
    expect((await member('POST', `/${later}/cancel`)).status).toBe(404);
    expect((await member('POST', '/msg_missing/cancel')).status).toBe(404);
    expect((await member('POST', '/msg_missing/send-now')).status).toBe(404);
  });
});
