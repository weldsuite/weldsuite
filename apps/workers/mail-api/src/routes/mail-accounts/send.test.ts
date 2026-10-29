/**
 * The send paths on a real pglite tenant and master database:
 * `POST /api/mail-accounts/:id/send` (compose) and
 * `POST /api/mail-messages/:id/reply`, through the outbound guard, recipient
 * validation (MX answers cached in a KV stub), attachments in a memory
 * bucket and a `SEND_EMAIL` stub that refuses some recipients the way
 * Cloudflare does. Refusals included: the binding missing, access, invalid
 * bodies and recipients, guard and provider refusals, a partial send.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

let master: MasterDatabase;

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  const { eq: equals, or } = await import('drizzle-orm');
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(master),
    getWorkspaceForOrg: async (_env: unknown, ref: string) => {
      const { workspaces } = actual.masterSchema;
      const [row] = await conformanceMasterDb(master)
        .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId })
        .from(workspaces)
        .where(or(equals(workspaces.clerkOrgId, ref), equals(workspaces.id, ref)))
        .limit(1);
      if (!row) throw new Error('Workspace not found');
      return row;
    },
  };
});

import { mailAccountsRoutes } from './index';
import { mailMessagesRoutes } from '../mail-messages/index';

const { mailAccounts, mailMessages, workspaceMembers, mailSuppressions } = schema;

let tenantDb: Database;

/** A KV stub with the MX answers the sends need, so nothing goes to the network. */
function kvStub() {
  const values = new Map<string, string>([
    ['mx:x.com', '1'],
    ['mx:y.com', '1'],
    ['mx:acme.com', '1'],
    ['mx:nomx.test', '0'],
  ]);
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

const sendEmail = createSendEmailStub({
  'suppressed@x.com': 'E_RECIPIENT_SUPPRESSED',
  'limit@y.com': 'E_DAILY_LIMIT_EXCEEDED',
  'rate@y.com': 'E_RATE_LIMIT_EXCEEDED',
  'boom@y.com': null,
});
const privateStorage = createMemoryR2();
const kv = kvStub();

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master
    .insert(masterSchema.workspaces)
    .values([
      { id: 'ws_test_default', name: 'Acme', slug: 'acme-send', clerkOrgId: 'org_test_default' },
      { id: 'ws_other', name: 'Other', slug: 'other-send', clerkOrgId: 'org_other' },
    ]);
  await master.insert(masterSchema.mailAccountRegistry).values([
    { id: 'mreg_send_1', email: 'tom@acme.com', workspaceId: 'ws_test_default', accountId: 'acc_shared' },
    { id: 'mreg_send_2', email: 'eve@other.com', workspaceId: 'ws_other', accountId: 'acc_other' },
  ]);
  await tenantDb.insert(workspaceMembers).values({
    id: 'wm_send_1',
    userId: 'user_test_default',
    email: 'user@acme.com',
    role: 'MEMBER',
  } as typeof workspaceMembers.$inferInsert);
  await tenantDb.insert(mailAccounts).values([
    { id: 'acc_shared', name: 'Sales', email: 'tom@acme.com', displayName: 'Tom Jansen', isShared: true },
    { id: 'acc_private', name: 'Private', email: 'priv@acme.com', isShared: false, assignedUserIds: ['user_other'] },
    { id: 'acc_spoof', name: 'Spoof', email: 'eve@other.com', isShared: true },
  ]);
  await tenantDb.insert(mailMessages).values([
    {
      id: 'msg_in_1',
      accountId: 'acc_shared',
      messageId: '<in-1@x.com>',
      threadId: 'thread_in_1',
      from: { email: 'anna@x.com', name: 'Anna' },
      to: [{ email: 'tom@acme.com' }, { email: 'bob@y.com' }],
      cc: [{ email: 'carol@y.com' }],
      subject: 'Re: Pricing question',
      references: ['<root@x.com>'],
      sentDate: new Date('2026-10-20T09:00:00Z'),
      source: 'inbound',
      labels: ['INBOX'],
    },
    {
      id: 'msg_sent_1',
      accountId: 'acc_shared',
      messageId: '<sent-1@acme.com>',
      threadId: 'thread_sent_1',
      from: { email: 'tom@acme.com' },
      to: [{ email: 'dave@x.com' }],
      subject: 'Following up',
      sentDate: new Date('2026-10-21T09:00:00Z'),
      source: 'sent',
      labels: ['SENT'],
    },
    {
      id: 'msg_private_1',
      accountId: 'acc_private',
      messageId: '<p-1@x.com>',
      from: { email: 'zed@x.com' },
      to: [{ email: 'priv@acme.com' }],
      subject: 'Private',
      sentDate: new Date('2026-10-20T09:00:00Z'),
      source: 'inbound',
    },
  ]);
  await tenantDb.insert(mailSuppressions).values({
    id: 'msup_send_1',
    email: 'angry@x.com',
    reason: 'complaint',
    source: 'cloudflare_event',
  });
  await privateStorage.put('workspaces/org_test_default/uploads/notes.txt', 'meeting notes', {
    httpMetadata: { contentType: 'text/plain' },
  });
}, 60_000);

function env(extra: Record<string, unknown> = {}) {
  return { SEND_EMAIL: sendEmail, WORKSPACE_CACHE: kv, PRIVATE_STORAGE: privateStorage, ...extra } as never;
}

function accounts(extra: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return createTestApp('/api/mail-accounts', mailAccountsRoutes, {
    context: {
      tenantDb,
      masterDb: master as unknown as Database,
      permissions: permissions('messages:create'),
      ...context,
    },
    env: env(extra),
  });
}

function messages(extra: Record<string, unknown> = {}) {
  return createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: { tenantDb, masterDb: master as unknown as Database, permissions: permissions('messages:create') },
    env: env(extra),
  });
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const compose = (account: string, body: unknown, extra?: Record<string, unknown>) =>
  accounts(extra).request(`/api/mail-accounts/${account}/send`, json(body));

describe('POST /api/mail-accounts/:id/send', () => {
  it('sends to every recipient and keeps a SENT copy', async () => {
    const res = await compose('acc_shared', {
      to: ['new.person@x.com'],
      cc: ['anna@x.com'],
      bcc: ['audit@y.com'],
      subject: 'Proposal',
      body: 'Hi,\n\nHere is the proposal.',
      htmlBody: '<p>Hi,</p><p>Here is the <b>proposal</b>.</p>',
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { messageId: string; smtpMessageId: string } };
    expect(data).toMatchObject({ pendingVerification: false, message: 'Email sent successfully' });
    expect(data.smtpMessageId).toMatch(/^<[0-9a-f]{32}@acme\.com>$/);

    const envelopes = sendEmail.sent.slice(-3);
    expect(envelopes.map((e) => e.to)).toEqual(['new.person@x.com', 'anna@x.com', 'audit@y.com']);
    expect(envelopes[0]!.from).toBe('"Tom Jansen" <tom@acme.com>');
    expect(envelopes[0]!.raw).not.toContain('audit@y.com');

    const [copy] = await tenantDb.select().from(mailMessages).where(eq(mailMessages.id, data.messageId));
    expect(copy).toMatchObject({
      accountId: 'acc_shared',
      source: 'sent',
      labels: ['SENT'],
      subject: 'Proposal',
      threadId: data.smtpMessageId,
      textBody: 'Hi,\n\nHere is the proposal.',
      htmlBody: '<p>Hi,</p><p>Here is the <b>proposal</b>.</p>',
      preview: 'Hi, Here is the proposal.',
      isRead: true,
    });
    const people = await tenantDb.select().from(schema.people).where(eq(schema.people.email, 'new.person@x.com'));
    expect(people[0]).toMatchObject({ firstName: 'new.person', displayName: 'new.person' });
  });

  it('sends an uploaded attachment and strips script from the HTML', async () => {
    const res = await compose('acc_shared', {
      to: ['bob@y.com'],
      subject: 'Notes',
      htmlBody: '<p onclick="x()">See notes</p><script>alert(1)</script>',
      attachments: [{ filename: 'notes.txt', size: 13, fileKey: 'workspaces/org_test_default/uploads/notes.txt' }],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { messageId: string } };
    const [copy] = await tenantDb.select().from(mailMessages).where(eq(mailMessages.id, data.messageId));
    expect(copy).toMatchObject({ htmlBody: '<p>See notes</p>', textBody: 'See notes', hasAttachments: true, attachmentCount: 1 });
    expect(sendEmail.sent.at(-1)!.raw).toContain('notes.txt');
  });

  it('refuses an attachment from outside the workspace', async () => {
    const res = await compose('acc_shared', {
      to: ['bob@y.com'],
      attachments: [{ filename: 'x.txt', size: 1, fileKey: 'workspaces/org_other/x.txt' }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: 'Attachment x.txt is not in this workspace' } });
  });

  it('returns the first send again for a replayed idempotency key', async () => {
    const body = { to: ['bob@y.com'], subject: 'Once', body: 'Only once', idempotencyKey: 'key-once-1' };
    const first = (await (await compose('acc_shared', body)).json()) as { data: { messageId: string } };
    const before = sendEmail.sent.length;
    const second = (await (await compose('acc_shared', body)).json()) as { data: { messageId: string } };
    expect(second.data.messageId).toBe(first.data.messageId);
    expect(sendEmail.sent).toHaveLength(before);
  });

  it('answers 503 without a send binding', async () => {
    const res = await compose('acc_shared', { to: ['bob@y.com'] }, { SEND_EMAIL: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'SEND_BINDING_MISSING' } });
  });

  it('hides a mailbox the caller may not use', async () => {
    expect((await compose('acc_private', { to: ['bob@y.com'] })).status).toBe(404);
    expect((await compose('acc_nope', { to: ['bob@y.com'] })).status).toBe(404);
  });

  it('validates the body', async () => {
    expect((await compose('acc_shared', { to: [] })).status).toBe(400);
    expect((await compose('acc_shared', { to: ['not-an-address'] })).status).toBe(400);
    expect((await compose('acc_shared', { to: ['bob@y.com'], importance: 'urgent' })).status).toBe(400);
  });

  it('refuses recipients whose domain takes no mail', async () => {
    const res = await compose('acc_shared', { to: ['someone@nomx.test'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'BAD_REQUEST', details: { invalidFormat: [], unreachableDomains: ['nomx.test'] } },
    });
  });

  it('refuses a recipient who complained (outbound guard)', async () => {
    const res = await compose('acc_shared', { to: ['angry@x.com'], body: 'Hello again' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'RECIPIENT_SUPPRESSED', details: { recipients: ['angry@x.com'] } } });
  });

  it('refuses an address registered to another workspace', async () => {
    const res = await compose('acc_spoof', { to: ['bob@y.com'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'SENDER_NOT_OWNED' } });
  });

  it("maps the provider's refusals", async () => {
    expect((await compose('acc_shared', { to: ['suppressed@x.com'] })).status).toBe(422);
    const daily = await compose('acc_shared', { to: ['limit@y.com'] });
    expect(daily.status).toBe(503);
    expect(await daily.json()).toMatchObject({ error: { code: 'PROVIDER_DAILY_LIMIT' } });
    const rate = await compose('acc_shared', { to: ['rate@y.com'] });
    expect(rate.status).toBe(429);
    expect(await rate.json()).toMatchObject({ error: { code: 'PROVIDER_RATE_LIMITED' } });
  });

  it('keeps a copy of a send that reached some recipients', async () => {
    const res = await compose('acc_shared', { to: ['erin@x.com', 'boom@y.com'], subject: 'Half' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; details: { sent: string[]; failed: string[] } } };
    expect(body.error).toMatchObject({ code: 'PARTIALLY_SENT', details: { sent: ['erin@x.com'], failed: ['boom@y.com'] } });
    const copies = await tenantDb.select().from(mailMessages).where(eq(mailMessages.subject, 'Half'));
    expect(copies[0]).toMatchObject({ deliveryStatus: 'failed', deliveryDetail: 'Not sent to: boom@y.com' });
  });

  it('notes recipients the provider skipped', async () => {
    const res = await compose('acc_shared', { to: ['frank@x.com', 'suppressed@x.com'], subject: 'Skipped one' });
    expect(res.status).toBe(200);
    const copies = await tenantDb.select().from(mailMessages).where(eq(mailMessages.subject, 'Skipped one'));
    expect(copies[0]).toMatchObject({
      deliveryStatus: 'rejected',
      deliveryDetail: 'Skipped, on the suppression list: suppressed@x.com',
    });
  });

  it("follows the workspace ledger's decision", async () => {
    const denial = {
      code: 'SENDING_LIMITED',
      window: 'hour',
      limit: 30,
      used: 30,
      retryAfter: '2099-01-01T00:00:00.000Z',
      reason: 'sender_hour',
    };
    const ledger = (decision: Record<string, unknown>) => ({
      idFromName: (name: string) => name,
      get: () => ({ reserve: async () => decision, commit: async () => undefined, release: async () => undefined }),
    });
    const refused = await compose(
      'acc_shared',
      { to: ['bob@y.com'], body: 'Hi' },
      { OUTBOUND_LEDGER: ledger({ allow: false, mode: 'enforce', reservationId: null, denial }) },
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'SENDING_LIMITED', details: denial } });
    const allowed = await compose(
      'acc_shared',
      { to: ['bob@y.com'], subject: 'Counted', body: 'Hi' },
      { OUTBOUND_LEDGER: ledger({ allow: true, mode: 'shadow', reservationId: 'r1', shadowDenial: denial }) },
    );
    expect(allowed.status).toBe(200);
  });

  it('needs messages:create and a workspace', async () => {
    const forbidden = await accounts({}, { permissions: permissions('messages:read') }).request(
      '/api/mail-accounts/acc_shared/send',
      json({ to: ['bob@y.com'] }),
    );
    expect(forbidden.status).toBe(403);
    const noOrg = await accounts({}, { orgId: null }).request('/api/mail-accounts/acc_shared/send', json({ to: ['bob@y.com'] }));
    expect(noOrg.status).toBe(400);
  });
});

describe('POST /api/mail-messages/:id/reply', () => {
  const reply = (id: string, body: unknown, extra?: Record<string, unknown>) =>
    messages(extra).request(`/api/mail-messages/${id}/reply`, json(body));

  it('answers the sender in the same thread', async () => {
    const res = await reply('msg_in_1', { body: 'Thanks Anna, the price is fine.' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { messageId: string; repliedTo: string } };
    expect(data.repliedTo).toBe('msg_in_1');
    const [copy] = await tenantDb.select().from(mailMessages).where(eq(mailMessages.id, data.messageId));
    expect(copy).toMatchObject({
      subject: 'Re: Pricing question',
      threadId: 'thread_in_1',
      inReplyTo: '<in-1@x.com>',
      references: ['<root@x.com>', '<in-1@x.com>'],
      isReply: true,
      to: [{ email: 'anna@x.com' }],
    });
    const envelope = sendEmail.sent.at(-1)!;
    expect(envelope.raw).toContain('In-Reply-To: <in-1@x.com>');
  });

  it('answers everyone with reply-all, cc staying cc', async () => {
    const res = await reply('msg_in_1', { body: 'Adding everyone.', replyAll: true });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { messageId: string } };
    const [copy] = await tenantDb.select().from(mailMessages).where(eq(mailMessages.id, data.messageId));
    expect(copy).toMatchObject({ to: [{ email: 'anna@x.com' }, { email: 'bob@y.com' }], cc: [{ email: 'carol@y.com' }] });
  });

  it('follows up on its own sent mail', async () => {
    const res = await reply('msg_sent_1', { htmlBody: '<p>Just checking in.</p>' });
    expect(res.status).toBe(200);
  });

  it('refuses unknown messages and private mailboxes', async () => {
    expect((await reply('msg_nope', { body: 'x' })).status).toBe(404);
    const blocked = await reply('msg_private_1', { body: 'x' });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { message: 'Access to this mail account is not allowed' } });
    expect((await reply('msg_in_1', { replyAll: 'yes' })).status).toBe(400);
  });

  it('answers 503 without a send binding', async () => {
    const res = await reply('msg_in_1', { body: 'x' }, { SEND_EMAIL: undefined });
    expect(res.status).toBe(503);
  });
});
