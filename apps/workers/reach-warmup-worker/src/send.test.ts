/**
 * Sender against a pglite master DB with a mocked SMTP client: every result
 * path, the message that goes out (no warmup markers), claims and retries.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SmtpSendResult } from '@weldsuite/smtp';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { sendMail } from '@weldsuite/smtp';
import { loadCorpus } from './corpus';
import type { WarmupSendMessage } from './env';
import { resetKillSwitchLog } from './lib/flag';
import { ENGAGE_DELAY_MAX_MINUTES, ENGAGE_DELAY_MIN_MINUTES, handleSendBatch } from './send';
import {
  FAKE_CTX,
  constant,
  createDueIndex,
  dueAt,
  fakeBatch,
  flagship,
  messages,
  pool,
  resetMaster,
  seedMailbox,
  seedMessage,
  testEnv,
} from './test-support/fixtures';

vi.mock('./corpus', () => import('./test-support/corpus-stub'));
vi.mock('@weldsuite/smtp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/smtp')>()),
  sendMail: vi.fn(),
}));

const NOW = new Date('2026-10-13T10:00:00Z');
const sendMailMock = vi.mocked(sendMail);

const OK: SmtpSendResult = { ok: true, response: '250 2.0.0 OK', accepted: ['b1@b1.test'] };
const failure = (overrides: Partial<Extract<SmtpSendResult, { ok: false }>> = {}): SmtpSendResult => ({
  ok: false,
  permanent: true,
  stage: 'rcpt',
  code: 550,
  response: '550 5.1.1 no such user',
  recipientRejected: true,
  authFailed: false,
  ...overrides,
});

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(OK);
  vi.mocked(loadCorpus).mockClear();
  await seedMailbox(master, { id: 'a1', rampDay: 5 });
  await seedMailbox(master, { id: 'b1', rampDay: 5 });
  await seedMessage(master, { id: 'm1', fromMailboxId: 'a1', toMailboxId: 'b1', claimedAt: new Date(NOW.getTime() - 30_000) });
});

async function send(ids: string[] = ['m1'], env = testEnv(), random = constant(0.5)) {
  const batch = fakeBatch<WarmupSendMessage>(
    'reach-warmup-send-test',
    ids.map((messageId) => ({ messageId })),
  );
  await handleSendBatch(batch as unknown as MessageBatch<WarmupSendMessage>, env, FAKE_CTX, {
    db: master,
    now: () => NOW,
    random,
  });
  return batch;
}

const row = async (id = 'm1') => (await master.select().from(messages).where(eq(messages.id, id)))[0]!;
const mailbox = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;
const raw = () => String(sendMailMock.mock.calls[0]![2]);

/** Header names of an RFC 5322 message, in order (continuation lines folded in). */
function headerNames(message: string): string[] {
  const head = message.split('\r\n\r\n')[0] ?? '';
  return head
    .split('\r\n')
    .filter((line) => !/^\s/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')));
}

describe('a send that works', () => {
  it('sends over the sender login to the recipient and records it', async () => {
    const batch = await send();

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [config, envelope] = sendMailMock.mock.calls[0]!;
    expect(config).toEqual({ host: 'smtp.test', port: 465, secure: true, username: 'a1@a1.test', password: 'pw' });
    expect(envelope).toEqual({ from: 'a1@a1.test', to: ['b1@b1.test'] });
    expect(raw()).toContain('Message-ID: <m1@a1.test>');
    expect(raw()).toContain('To: B1 Tester <b1@b1.test>');
    expect(raw()).toContain('Subject: Quarterly planning');
    // Names filled in per pair, by the corpus renderer.
    expect(raw()).toContain('Hi B1, can we plan the quarter? A1');

    const sent = await row();
    expect(sent).toMatchObject({ status: 'sent', sentAt: NOW, claimedAt: null, error: null });
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0]!.retry).not.toHaveBeenCalled();
  });

  it('schedules the engagement 10 to 120 minutes later', async () => {
    await send(['m1'], testEnv(), constant(0));
    expect((await row()).engageAt).toEqual(new Date(NOW.getTime() + ENGAGE_DELAY_MIN_MINUTES * 60_000));

    await master.update(messages).set({ status: 'scheduled', claimedAt: null }).where(eq(messages.id, 'm1'));
    await send(['m1'], testEnv(), constant(0.999999));
    const latest = (await row()).engageAt!.getTime();
    expect(latest).toBeLessThanOrEqual(NOW.getTime() + ENGAGE_DELAY_MAX_MINUTES * 60_000);
    expect(latest).toBeGreaterThan(NOW.getTime() + (ENGAGE_DELAY_MAX_MINUTES - 1) * 60_000);
  });

  it('carries nothing that marks it as warmup', async () => {
    await send();

    expect(headerNames(raw()).sort()).toEqual(
      ['Content-Transfer-Encoding', 'Content-Type', 'Date', 'From', 'Message-ID', 'MIME-Version', 'Subject', 'To'].sort(),
    );
    expect(raw()).not.toMatch(/warmup|list-unsubscribe|x-mailer|precedence|auto-submitted|x-/i);
  });

  it('threads a reply with In-Reply-To and References, from the other mailbox', async () => {
    await seedMessage(master, {
      id: 'reply',
      fromMailboxId: 'b1',
      toMailboxId: 'a1',
      step: 1,
      messageIdHeader: 'reply@b1.test',
      inReplyTo: 'm1@a1.test',
      references: 'first@a1.test m1@a1.test',
      subject: 'Re: Quarterly planning',
      claimedAt: NOW,
    });

    await send(['reply']);

    expect(sendMailMock.mock.calls[0]![1]).toEqual({ from: 'b1@b1.test', to: ['a1@a1.test'] });
    expect(raw()).toContain('Subject: Re: Quarterly planning');
    expect(raw()).toContain('In-Reply-To: <m1@a1.test>');
    expect(raw()).toContain('References: <first@a1.test> <m1@a1.test>');
    expect(raw()).toContain('Hi A1, yes. B1');
    expect(await row('reply')).toMatchObject({ status: 'sent' });
  });

  it('clears an earlier login error of the sender', async () => {
    await master.update(pool).set({ lastLoginError: 'imap: old', lastLoginErrorAt: NOW }).where(eq(pool.id, 'a1'));
    const index = createDueIndex();

    await send(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(await mailbox('a1')).toMatchObject({ lastLoginError: null, lastLoginErrorAt: null, status: 'warming' });
    // reach-api's sweep is told the error is gone.
    expect(await dueAt(index, 'org_a1')).toBe(NOW.getTime());
  });
});

describe('a send that does not work', () => {
  it('a rejected login puts the sender in error (login_failed) and fails the message', async () => {
    sendMailMock.mockResolvedValue(
      failure({ authFailed: true, stage: 'auth', code: 535, response: '535 5.7.8 bad credentials', recipientRejected: false }),
    );
    const index = createDueIndex();

    const batch = await send(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(await mailbox('a1')).toMatchObject({
      status: 'error',
      pausedReason: 'login_failed',
      lastLoginError: 'smtp: 535 5.7.8 bad credentials',
      lastLoginErrorAt: NOW,
    });
    expect(await row()).toMatchObject({ status: 'failed', claimedAt: null });
    expect((await row()).error).toContain('535');
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(await dueAt(index, 'org_a1')).toBe(NOW.getTime());
    // The recipient is not blamed.
    expect(await mailbox('b1')).toMatchObject({ status: 'warming', lastLoginError: null });
  });

  it('a delivery that may have happened counts as sent', async () => {
    sendMailMock.mockResolvedValue(failure({ permanent: false, stage: 'data', recipientRejected: false, deliveryUncertain: true, response: 'connection reset' }));

    await send();

    expect(await row()).toMatchObject({ status: 'sent', sentAt: NOW, error: 'delivery_uncertain', claimedAt: null });
    expect((await row()).engageAt).not.toBeNull();
  });

  it('any other failure fails the message without retry and leaves the mailboxes alone', async () => {
    const batch = await send();
    expect(batch.messages[0]!.retry).not.toHaveBeenCalled();

    await master.update(messages).set({ status: 'scheduled', claimedAt: null }).where(eq(messages.id, 'm1'));
    sendMailMock.mockResolvedValue(failure());
    const again = await send();

    expect(await row()).toMatchObject({ status: 'failed', error: 'smtp rcpt 550: 550 5.1.1 no such user', claimedAt: null });
    expect(again.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(again.messages[0]!.retry).not.toHaveBeenCalled();
    expect(await mailbox('a1')).toMatchObject({ status: 'warming' });
  });

  it.each([
    ['the recipient is paused', { id: 'b1', status: 'paused' as const }],
    ['the sender is in error', { id: 'a1', status: 'error' as const }],
    ['the sender is removed', { id: 'a1', status: 'removed' as const }],
  ])('fails the message without sending when %s', async (_name, change) => {
    await master.update(pool).set({ status: change.status }).where(eq(pool.id, change.id));

    const batch = await send();

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'failed', error: 'mailbox_inactive', claimedAt: null });
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  it('pauses the sender when its login cannot be opened', async () => {
    await master.update(pool).set({ smtpCredentials: 'garbage' }).where(eq(pool.id, 'a1'));
    const index = createDueIndex();

    await send(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await mailbox('a1')).toMatchObject({
      status: 'paused',
      pausedReason: 'credentials_unavailable',
      lastLoginError: 'credentials_unavailable',
    });
    expect(await row()).toMatchObject({ status: 'failed', error: 'credentials_unavailable' });
    expect(await dueAt(index, 'org_a1')).toBe(NOW.getTime());
  });

  it('fails a message whose corpus thread no longer exists', async () => {
    await master.update(messages).set({ corpusThreadId: 'gone' }).where(eq(messages.id, 'm1'));

    await send();

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'failed', error: 'corpus_thread_missing' });
  });

  it('fails a message whose step is beyond the thread', async () => {
    await master.update(messages).set({ step: 9 }).where(eq(messages.id, 'm1'));

    await send();

    expect(await row()).toMatchObject({ status: 'failed' });
    expect((await row()).error).toMatch(/^render_failed/);
  });
});

describe('queue handling', () => {
  it('skips a message that is no longer scheduled', async () => {
    await master.update(messages).set({ status: 'sent' }).where(eq(messages.id, 'm1'));

    const batch = await send();

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  it('drops a queue message without a messageId instead of retrying it forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const batch = fakeBatch<unknown>('reach-warmup-send-test', [{}, { messageId: 42 }, null]);

    await handleSendBatch(batch as unknown as MessageBatch<WarmupSendMessage>, testEnv(), FAKE_CTX, { db: master, now: () => NOW });

    expect(batch.messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true);
    expect(batch.messages.every((message) => message.retry.mock.calls.length === 0)).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips an unknown message', async () => {
    const batch = await send(['nope']);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  it('sends a message once when two consumers get it', async () => {
    const env = testEnv();
    const [first, second] = await Promise.all([send(['m1'], env), send(['m1'], env)]);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(first.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(second.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: 'sent' });
  });

  it('retries on an unexpected error and keeps the message scheduled', async () => {
    sendMailMock.mockRejectedValue(new Error('socket exploded'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const batch = await send();

    expect(batch.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(batch.messages[0]!.ack).not.toHaveBeenCalled();
    expect((await row()).status).toBe('scheduled');
    error.mockRestore();

    // The retry is allowed to take the message again.
    sendMailMock.mockResolvedValue(OK);
    await send();
    expect((await row()).status).toBe('sent');
  });

  it('handles every message of a batch', async () => {
    await seedMessage(master, { id: 'm2', fromMailboxId: 'b1', toMailboxId: 'a1', messageIdHeader: 'm2@b1.test' });

    const batch = await send(['m1', 'm2']);

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(batch.messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true);
  });

  it('sends nothing while the kill switch is off and hands the claims back', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const batch = await send(['m1'], testEnv({ FLAGSHIP: flagship(false) }));

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: 'scheduled', claimedAt: null });
    log.mockRestore();
  });
});
