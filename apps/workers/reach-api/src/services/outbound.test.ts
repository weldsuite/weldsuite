import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { reachMailboxes, reachMessages } from '@weldsuite/db/schema';

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  built: [] as Array<Record<string, unknown>>,
  counter: 0,
}));

vi.mock('@weldsuite/smtp', () => ({
  buildMimeMessage: (message: Record<string, unknown>) => {
    smtp.built.push(message);
    return JSON.stringify(message);
  },
  generateMessageId: (domain: string) => `msg${++smtp.counter}@${domain}`,
  sendMail: (...args: unknown[]) => smtp.sendMail(...args),
}));

import { sendFromMailbox, type SendFromMailboxInput } from './outbound';
import { resetReach, seedMailbox, seedSettings, testEnv } from '../test-support/reach';

let db: Database;
const env = testEnv();
const T0 = new Date('2026-10-12T10:00:00Z');
const deps = () => ({ env, db, now: () => T0 });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  smtp.sendMail.mockReset();
  smtp.sendMail.mockResolvedValue({ ok: true, response: '250 2.0.0 OK', accepted: ['jane@bigco.io'] });
  smtp.built.length = 0;
});

const input = (mailboxId: string, overrides: Partial<SendFromMailboxInput> = {}): SendFromMailboxInput => ({
  mailboxId,
  to: { email: 'jane@bigco.io', name: 'Jane Doe' },
  subject: 'Hello Jane',
  text: 'Hi Jane, a quick question.',
  appendFooter: true,
  ...overrides,
});

const failure = (extra: Record<string, unknown>) => ({
  ok: false,
  permanent: false,
  stage: 'rcpt',
  response: 'nope',
  recipientRejected: false,
  authFailed: false,
  ...extra,
});

describe('sendFromMailbox', () => {
  it('writes the message row (status sending) BEFORE the SMTP transaction, then marks it sent', async () => {
    const mailbox = await seedMailbox(db);
    let statusAtSmtpTime: string | null = null;
    smtp.sendMail.mockImplementation(async () => {
      const [row] = await db.select().from(reachMessages);
      statusAtSmtpTime = row?.status ?? null;
      return { ok: true, response: '250 2.0.0 OK 123 - gsmtp', accepted: ['jane@bigco.io'] };
    });

    const result = await sendFromMailbox(deps(), input(mailbox.id, { campaignId: 'rcmp_1', enrollmentId: 'renr_1', stepId: 'rstp_1', prospectId: 'rpro_1' }));

    expect(statusAtSmtpTime).toBe('sending');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toMatchObject({
      direction: 'out',
      status: 'sent',
      smtpResponse: '250 2.0.0 OK 123 - gsmtp',
      fromEmail: mailbox.email,
      toEmail: 'jane@bigco.io',
      subject: 'Hello Jane',
      campaignId: 'rcmp_1',
      enrollmentId: 'renr_1',
      stepId: 'rstp_1',
      prospectId: 'rpro_1',
    });
    expect(result.message.sentAt).toEqual(T0);
    expect(result.message.messageIdHeader).toMatch(/^msg\d+@getacme\.com$/);
    expect(result.message.threadKey).toBe(result.message.messageIdHeader);
    const [mb] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(mb?.lastSentAt).toEqual(T0);
  });

  it('submits over implicit TLS on 465 and STARTTLS on 587, with the mailbox login', async () => {
    const tls = await seedMailbox(db, { port: 465, password: 'secret465' });
    const starttls = await seedMailbox(db, { port: 587, password: 'secret587' });
    await sendFromMailbox(deps(), input(tls.id));
    await sendFromMailbox(deps(), input(starttls.id));

    const [first, second] = smtp.sendMail.mock.calls as Array<[Record<string, unknown>, Record<string, unknown>, string, unknown]>;
    expect(first?.[0]).toMatchObject({ host: 'smtp.mailpool.test', port: 465, secure: true, username: tls.email, password: 'secret465' });
    expect(first?.[1]).toEqual({ from: tls.email, to: ['jane@bigco.io'] });
    expect(second?.[0]).toMatchObject({ port: 587, secure: false, password: 'secret587' });
  });

  it('adds the opt-out footer, the sender identity and a mailto List-Unsubscribe, and nothing from WeldSuite', async () => {
    await seedSettings(db, { senderCompanyName: 'Acme BV', senderAddress: 'Keizersgracht 1, Amsterdam', optOutText: 'Reply stop to opt out.' });
    const mailbox = await seedMailbox(db);
    await sendFromMailbox(deps(), input(mailbox.id));

    const built = smtp.built[0] as { from: { email: string; name: string }; text: string; headers: Record<string, string>; to: unknown };
    expect(built.from).toEqual({ email: mailbox.email, name: 'Sam Taylor' });
    expect(built.text).toBe('Hi Jane, a quick question.\n\n-- \nReply stop to opt out.\nAcme BV\nKeizersgracht 1, Amsterdam');
    expect(built.headers).toEqual({ 'List-Unsubscribe': `<mailto:${mailbox.email}?subject=unsubscribe>` });
    expect(JSON.stringify(built).toLowerCase()).not.toContain('weldsuite');
    expect(JSON.stringify(built)).not.toContain('X-Mailer');
  });

  it('falls back to the default opt-out line when the workspace has not written one', async () => {
    await seedSettings(db, { optOutText: null });
    const mailbox = await seedMailbox(db);
    await sendFromMailbox(deps(), input(mailbox.id));
    expect((smtp.built[0] as { text: string }).text).toContain("If you'd rather not hear from me, just reply 'stop' and I won't email you again.");
  });

  it('leaves the footer off for a reply that asks for none, and stores the final text', async () => {
    const mailbox = await seedMailbox(db);
    const result = await sendFromMailbox(deps(), input(mailbox.id, { appendFooter: false, text: 'Thanks, Friday works.' }));
    expect((smtp.built[0] as { text: string }).text).toBe('Thanks, Friday works.');
    expect(result.ok && result.message.bodyText).toBe('Thanks, Friday works.');
  });

  it('threads a follow-up: In-Reply-To, References and the conversation key', async () => {
    const mailbox = await seedMailbox(db);
    const result = await sendFromMailbox(
      deps(),
      input(mailbox.id, { subject: 'Re: Hello', inReplyTo: 'a@getacme.com', references: ['root@getacme.com', 'a@getacme.com'], threadKey: 'root@getacme.com' }),
    );
    expect(smtp.built[0]).toMatchObject({ inReplyTo: 'a@getacme.com', references: ['root@getacme.com', 'a@getacme.com'] });
    expect(result.ok && result.message).toMatchObject({
      threadKey: 'root@getacme.com',
      inReplyTo: 'a@getacme.com',
      references: 'root@getacme.com a@getacme.com',
    });
  });

  it('refuses a campaign send from a mailbox that is not active, but lets a person answer from warming or paused ones', async () => {
    const warming = await seedMailbox(db, { status: 'warming' });
    const refused = await sendFromMailbox(deps(), input(warming.id));
    expect(refused).toMatchObject({ ok: false, message: null, permanent: true });
    expect(smtp.sendMail).not.toHaveBeenCalled();

    const answered = await sendFromMailbox(deps(), input(warming.id, { sentBy: 'user_1' }));
    expect(answered.ok).toBe(true);
    const paused = await seedMailbox(db, { status: 'paused' });
    expect((await sendFromMailbox(deps(), input(paused.id, { sentBy: 'user_1' }))).ok).toBe(true);

    for (const status of ['suspended', 'error', 'provisioning', 'deleting'] as const) {
      const unusable = await seedMailbox(db, { status });
      expect((await sendFromMailbox(deps(), input(unusable.id, { sentBy: 'user_1' }))).ok).toBe(false);
    }
  });

  it('fails permanently, without a row, when the mailbox is gone or has no usable credentials', async () => {
    const missing = await sendFromMailbox(deps(), input('rmbx_nope'));
    expect(missing).toMatchObject({ ok: false, message: null, permanent: true, error: 'mailbox_not_found' });

    const broken = await seedMailbox(db);
    await db.update(reachMailboxes).set({ smtpCredentials: null }).where(eq(reachMailboxes.id, broken.id));
    const noCreds = await sendFromMailbox(deps(), input(broken.id));
    expect(noCreds).toMatchObject({ ok: false, message: null, permanent: true, error: 'credentials_unavailable' });
    expect(await db.select().from(reachMessages)).toHaveLength(0);
  });

  it('keeps a failed row and reports a rejected recipient as a hard bounce', async () => {
    const mailbox = await seedMailbox(db);
    smtp.sendMail.mockResolvedValue(failure({ permanent: true, code: 550, enhancedCode: '5.1.1', response: '550 5.1.1 no such user', recipientRejected: true }));
    const result = await sendFromMailbox(deps(), input(mailbox.id));
    expect(result).toMatchObject({ ok: false, permanent: true, recipientRejected: true, authFailed: false });
    if (result.ok) return;
    expect(result.message).toMatchObject({ status: 'failed', smtpResponse: '550 5.1.1 no such user' });
    expect(result.error).toContain('550 5.1.1 no such user');
    const [mb] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(mb?.lastSentAt).toBeNull();
  });

  it('reports bad credentials and temporary failures', async () => {
    const mailbox = await seedMailbox(db);
    smtp.sendMail.mockResolvedValueOnce(failure({ permanent: true, stage: 'auth', code: 535, authFailed: true }));
    expect(await sendFromMailbox(deps(), input(mailbox.id))).toMatchObject({ ok: false, authFailed: true, permanent: true });

    smtp.sendMail.mockResolvedValueOnce(failure({ permanent: false, stage: 'rcpt', code: 451 }));
    const temporary = await sendFromMailbox(deps(), input(mailbox.id));
    expect(temporary).toMatchObject({ ok: false, permanent: false, recipientRejected: false, authFailed: false });
    expect(temporary.ok === false && temporary.message?.status).toBe('failed');
  });

  it('marks a send whose delivery is uncertain as unknown and never as retryable', async () => {
    const mailbox = await seedMailbox(db);
    smtp.sendMail.mockResolvedValue(failure({ stage: 'timeout', response: 'Timed out waiting for the reply to DATA', deliveryUncertain: true }));
    const result = await sendFromMailbox(deps(), input(mailbox.id));
    expect(result).toMatchObject({ ok: false, permanent: true });
    expect(result.ok === false && result.message?.status).toBe('unknown');
  });

  it('marks the row unknown when the SMTP client itself throws', async () => {
    const mailbox = await seedMailbox(db);
    smtp.sendMail.mockRejectedValue(new Error('socket exploded'));
    const result = await sendFromMailbox(deps(), input(mailbox.id));
    expect(result).toMatchObject({ ok: false, permanent: true });
    expect(result.ok === false && result.message?.status).toBe('unknown');
    expect(result.ok === false && result.error).toContain('socket exploded');
  });
});
