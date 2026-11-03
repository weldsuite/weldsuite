/**
 * POST /api/reach/inbox/threads/:threadKey/reply through the real
 * `sendFromMailbox`: the message row, the SMTP submission and its outcome.
 * `@weldsuite/smtp`'s `sendMail` is a double that answers by recipient, and
 * the same double is the test's `SMTP_SEND` binding, so in conformance mode
 * the Rust server's submission (over the harness's SMTP bridge) gets the same
 * answer.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import { reachMessages } from '@weldsuite/db/schema';
import { sealMailServerCredentials } from '@weldsuite/reach-domain/credentials';
import type { Env, Variables } from '../../types';
import { resetTables, seedInbound, seedMailbox, seedOutbound, seedProspect } from '../../email/test-support';

/** `sendMail`'s answer by recipient: refused, uncertain, or accepted. */
const smtp = vi.hoisted(() => ({
  sendMail: async (_config: unknown, envelope: { to: string[] }, _raw: string) => {
    const to = envelope.to[0] ?? '';
    if (to.startsWith('refused@')) {
      return { ok: false, permanent: true, stage: 'rcpt', code: 550, response: '550 5.1.1 user unknown', recipientRejected: true, authFailed: false };
    }
    if (to.startsWith('uncertain@')) {
      return { ok: false, permanent: false, stage: 'timeout', response: 'no reply after DATA', recipientRejected: false, authFailed: false, deliveryUncertain: true };
    }
    if (to.startsWith('throws@')) throw new Error('socket closed');
    return { ok: true, response: '250 2.0.0 OK queued', accepted: [to] };
  },
}));
vi.mock('@weldsuite/smtp', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/smtp')>('@weldsuite/smtp');
  return { ...actual, sendMail: (config: unknown, envelope: { to: string[] }, raw: string) => smtp.sendMail(config, envelope, raw) };
});

const { default: inboxRoutes } = await import('./index');

const KEY = 'ab'.repeat(32);
const BASE = '/api/reach/inbox';
const approved: AppAccess = { workspaceId: 'ws_1', status: 'approved', limits: {}, billingStatus: 'none', billingStatusAt: null };

let db: Database;

function app(access: AppAccess = approved) {
  return createTestApp<Env, Variables>(BASE, inboxRoutes, {
    context: { appAccess: access, permissions: permissions('reach_inbox:read', 'reach_inbox:reply'), tenantDb: db },
    env: { DATABASE_ENCRYPTION_KEY: KEY, SMTP_SEND: smtp } as unknown as Partial<Env>,
  });
}

const reply = (threadKey: string, body = 'Thanks, Tuesday works.') =>
  app().request(`${BASE}/threads/${encodeURIComponent(threadKey)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

/** A thread `out-<name>@getacme.com` whose reply came from `<from>`. */
async function seedThread(name: string, from: string, mailboxId: string) {
  await seedOutbound(db, { messageIdHeader: `out-${name}@getacme.com`, mailboxId, toEmail: from, subject: 'Quick question' });
  await seedInbound(db, {
    messageIdHeader: `in-${name}@mail.example`,
    threadKey: `out-${name}@getacme.com`,
    mailboxId,
    fromEmail: from,
    subject: 'RE: Quick question',
    receivedAt: new Date('2026-10-12T10:00:00Z'),
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  const login = { host: 'smtp.mailpool.test', port: 587, tls: true, username: 'sam@getacme.com', password: 'smtp-secret' };
  const mailbox = await seedMailbox(db, { id: 'rmbx_sam', smtpCredentials: await sealMailServerCredentials({ DATABASE_ENCRYPTION_KEY: KEY }, login) });
  await seedMailbox(db, { id: 'rmbx_nologin', email: 'kim@getacme.com', inboundToken: 'b'.repeat(32) });
  await seedProspect(db, { email: 'tom@redwood.eu', firstName: 'Tom', lastName: 'Smit' });
  await seedThread('ok', 'tom@redwood.eu', mailbox.id);
  await seedThread('refused', 'refused@redwood.eu', mailbox.id);
  await seedThread('uncertain', 'uncertain@redwood.eu', mailbox.id);
  await seedThread('throws', 'throws@redwood.eu', mailbox.id);
  await seedThread('nologin', 'ann@redwood.eu', 'rmbx_nologin');
});

describe('POST /threads/:threadKey/reply', () => {
  it('sends the answer threaded under the reply and marks the thread read', async () => {
    const res = await reply('out-ok@getacme.com');
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ direction: 'out', status: 'sent', toEmail: 'tom@redwood.eu', subject: 'Re: Quick question', threadKey: 'out-ok@getacme.com' });
    const inbound = (await db.select().from(reachMessages)).filter((m) => m.direction === 'in' && m.threadKey === 'out-ok@getacme.com');
    expect(inbound.every((m) => m.readAt !== null)).toBe(true);
  });

  it('answers 502 with the server’s refusal, keeping the failed row', async () => {
    const res = await reply('out-refused@getacme.com');
    expect(res.status).toBe(502);
    const failed = (await db.select().from(reachMessages)).find((m) => m.toEmail === 'refused@redwood.eu' && m.direction === 'out' && m.sentBy);
    expect(failed?.status).toBe('failed');
  });

  it('records a delivery it cannot be sure of as unknown', async () => {
    expect((await reply('out-uncertain@getacme.com')).status).toBe(502);
    const row = (await db.select().from(reachMessages)).find((m) => m.toEmail === 'uncertain@redwood.eu' && m.sentBy);
    expect(row?.status).toBe('unknown');
  });

  it('answers 502 when the submission throws, and when the mailbox has no login', async () => {
    expect((await reply('out-throws@getacme.com')).status).toBe(502);
    expect((await reply('out-nologin@getacme.com')).status).toBe(502);
  });
});
