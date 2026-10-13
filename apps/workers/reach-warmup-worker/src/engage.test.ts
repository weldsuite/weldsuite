/**
 * Engager against a pglite master DB and scripted IMAP accounts: where mail
 * landed, the actions taken, retries, replies and login failures.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ImapError, connectImap } from '@weldsuite/imap';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { loadCorpus } from './corpus';
import type { WarmupEngageMessage } from './env';
import {
  INACTIVE_GIVE_UP_MS,
  LOGIN_RETRY_MS,
  NOT_FOUND_RETRY_MS,
  TRANSIENT_RETRY_MS,
  handleEngageBatch,
} from './engage';
import { resetKillSwitchLog } from './lib/flag';
import {
  FAKE_CTX,
  FakeImapAccount,
  createDueIndex,
  dueAt,
  fakeBatch,
  flagship,
  messages,
  pool,
  resetMaster,
  routeImap,
  seedMailbox,
  seedMessage,
  sequence,
  testEnv,
} from './test-support/fixtures';

vi.mock('./corpus', () => import('./test-support/corpus-stub'));
vi.mock('@weldsuite/imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/imap')>()),
  connectImap: vi.fn(),
}));

const NOW = new Date('2026-10-13T10:00:00Z'); // Tuesday, 10:00 UTC
const connectMock = vi.mocked(connectImap);
const MESSAGE_ID = 'mid1@a1.test';
const B1 = 'b1@b1.test';

const noReplyRolls = () => sequence(0.99, 0.5, 0.99);
const replyRolls = () => sequence(0.99, 0.5, 0, 0.5, 0.5, 0.5);

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  connectMock.mockReset();
  vi.mocked(loadCorpus).mockClear();
  await seedMailbox(master, { id: 'a1', rampDay: 5 });
  await seedMailbox(master, { id: 'b1', rampDay: 5 });
  await seedSent('m1');
});

function seedSent(id: string, overrides: Partial<typeof messages.$inferInsert> = {}) {
  return seedMessage(master, {
    id,
    fromMailboxId: 'a1',
    toMailboxId: 'b1',
    messageIdHeader: id === 'm1' ? MESSAGE_ID : `${id}@a1.test`,
    status: 'sent',
    sentAt: new Date(NOW.getTime() - 30 * 60_000),
    engageAt: new Date(NOW.getTime() - 60_000),
    claimedAt: new Date(NOW.getTime() - 30_000),
    ...overrides,
  });
}

async function engage(ids: string[] = ['m1'], env = testEnv(), random = noReplyRolls(), now = NOW) {
  const batch = fakeBatch<WarmupEngageMessage>(
    'reach-warmup-engage-test',
    ids.map((messageId) => ({ messageId })),
  );
  await handleEngageBatch(batch as unknown as MessageBatch<WarmupEngageMessage>, env, FAKE_CTX, {
    db: master,
    now: () => now,
    random,
  });
  return batch;
}

const row = async (id = 'm1') => (await master.select().from(messages).where(eq(messages.id, id)))[0]!;
const mailbox = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;
const replies = async (minStep = 1) => (await master.select().from(messages)).filter((message) => message.step >= minStep);

function account(options: ConstructorParameters<typeof FakeImapAccount>[0] = {}, inInbox = true) {
  const fake = new FakeImapAccount({ special: { '\\Junk': 'Spam' }, ...options });
  if (inInbox) fake.put('INBOX', MESSAGE_ID);
  routeImap(connectMock, { [B1]: fake });
  return fake;
}

describe('where the mail landed', () => {
  it('finds it in the inbox, reads it and records the placement', async () => {
    const imap = account();

    const batch = await engage();

    expect(connectMock).toHaveBeenCalledWith({ host: 'imap.test', port: 993, username: B1, password: 'pw' });
    expect(imap.find(MESSAGE_ID)!.message.flags).toEqual(new Set(['\\Seen']));
    expect(await row()).toMatchObject({
      status: 'engaged',
      placement: 'inbox',
      engagedAt: NOW,
      claimedAt: null,
      actions: { seen: true },
    });
    expect(imap.loggedOut).toBe(true);
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  it('flags about one in five as important', async () => {
    const imap = account();

    await engage(['m1'], testEnv(), sequence(0, 0.5, 0.99));

    expect(imap.find(MESSAGE_ID)!.message.flags).toEqual(new Set(['\\Seen', '\\Flagged']));
    expect((await row()).actions).toEqual({ seen: true, flagged: true });
  });

  it('moves mail found in spam to the inbox and records it as spam', async () => {
    const imap = account({}, false);
    imap.put('Spam', MESSAGE_ID);

    await engage();

    expect(imap.find(MESSAGE_ID)!.folder).toBe('INBOX');
    expect(imap.find(MESSAGE_ID)!.message.flags.has('\\Seen')).toBe(true);
    expect(imap.calls).toEqual(expect.arrayContaining(['findSpecialUse \\Junk', 'select Spam', 'move INBOX']));
    expect(await row()).toMatchObject({ status: 'engaged', placement: 'spam', actions: { seen: true, movedFromSpam: true } });
    expect(imap.loggedOut).toBe(true);
  });

  it('does not go looking in spam when the inbox has it', async () => {
    const imap = account();

    await engage();

    expect(imap.calls).not.toContain('findSpecialUse \\Junk');
  });

  it('looks again in 2 hours when it is nowhere, and says missing after the third try', async () => {
    const imap = account({}, false);

    await engage();
    expect(await row()).toMatchObject({
      status: 'sent',
      engageAttempts: 1,
      engageAt: new Date(NOW.getTime() + NOT_FOUND_RETRY_MS),
      claimedAt: null,
      placement: null,
    });

    await engage();
    expect(await row()).toMatchObject({ status: 'sent', engageAttempts: 2 });

    const third = await engage();
    expect(await row()).toMatchObject({ status: 'missing', placement: 'missing', engageAttempts: 3, claimedAt: null });
    expect(third.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(imap.loggedOut).toBe(true);
    expect(await replies()).toHaveLength(0);
  });

  it('treats an account without a Junk folder as not found when the inbox lacks it', async () => {
    account({ special: {} }, false);

    await engage();

    expect(await row()).toMatchObject({ status: 'sent', engageAttempts: 1 });
  });
});

describe('replies', () => {
  it('schedules the next step from the recipient back to the sender, in the same thread', async () => {
    account();

    await engage(['m1'], testEnv(), replyRolls());

    const [reply] = await replies();
    expect(reply).toMatchObject({
      threadId: 'th_m1',
      step: 1,
      fromMailboxId: 'b1',
      toMailboxId: 'a1',
      corpusThreadId: 'stub-001',
      inReplyTo: MESSAGE_ID,
      references: MESSAGE_ID,
      subject: 'Re: Quarterly planning',
      status: 'scheduled',
    });
    expect(reply!.id).toMatch(/^rwms_/);
    expect(reply!.messageIdHeader).toMatch(/^[0-9a-f]{32}\.[a-z0-9]+@b1\.test$/);
    // 20 minutes to 4 hours after the engagement (here 130 minutes), inside UTC business hours.
    expect(reply!.scheduledAt).toEqual(new Date(NOW.getTime() + 130 * 60_000));
    expect((await row()).actions).toEqual({ seen: true, replyScheduled: true });
  });

  it('extends the References chain on a later step', async () => {
    await seedSent('m2', { step: 1, fromMailboxId: 'b1', toMailboxId: 'a1', inReplyTo: 'first@a1.test', references: 'first@a1.test' });
    const imap = new FakeImapAccount();
    imap.put('INBOX', 'm2@a1.test');
    routeImap(connectMock, { 'a1@a1.test': imap });

    await engage(['m2'], testEnv(), sequence(0.99, 0, 0.5, 0.5));

    const [reply] = await replies().then((all) => all.filter((message) => message.step === 2));
    expect(reply).toMatchObject({
      fromMailboxId: 'a1',
      toMailboxId: 'b1',
      step: 2,
      inReplyTo: 'm2@a1.test',
      references: 'first@a1.test m2@a1.test',
    });
  });

  it('does not reply when the roll says no', async () => {
    account();

    await engage(['m1'], testEnv(), noReplyRolls());

    expect(await replies()).toHaveLength(0);
    expect((await row()).actions).toEqual({ seen: true });
  });

  it('replies to about a third of first messages', async () => {
    account();
    let replied = 0;
    const rolls = 200;
    for (let i = 0; i < rolls; i++) {
      const id = `bulk${i}`;
      await seedSent(id);
      const imap = new FakeImapAccount();
      imap.put('INBOX', `${id}@a1.test`);
      routeImap(connectMock, { [B1]: imap });
      const roll = (i + 0.5) / rolls;
      await engage([id], testEnv(), sequence(0.99, 0.5, roll, 0.5));
    }
    replied = (await replies()).length;
    // The rate is drawn from 30-45% per message: expect between 25% and 50% of 200.
    expect(replied).toBeGreaterThan(rolls * 0.25);
    expect(replied).toBeLessThan(rolls * 0.5);
  });

  it('does not reply past the end of the thread', async () => {
    await seedSent('short', { corpusThreadId: 'stub-002', step: 1, fromMailboxId: 'b1', toMailboxId: 'a1' });
    const imap = new FakeImapAccount();
    imap.put('INBOX', 'short@a1.test');
    routeImap(connectMock, { 'a1@a1.test': imap });

    await engage(['short'], testEnv(), replyRolls());

    expect(await replies(2)).toHaveLength(0);
    expect((await row('short')).status).toBe('engaged');
  });

  it('does not reply to a mailbox that has left the network', async () => {
    account();
    await master.update(pool).set({ status: 'paused' }).where(eq(pool.id, 'a1'));

    await engage(['m1'], testEnv(), replyRolls());

    expect(await replies()).toHaveLength(0);
    expect((await row()).status).toBe('engaged');
  });

  it('adds only one reply when the engagement is handled twice', async () => {
    account();
    await engage(['m1'], testEnv(), replyRolls());
    // The first run's result is lost: the row is back to sent and claimed.
    await master.update(messages).set({ status: 'sent', claimedAt: null }).where(eq(messages.id, 'm1'));

    await engage(['m1'], testEnv(), replyRolls());

    expect(await replies()).toHaveLength(1);
    expect((await row()).actions).toMatchObject({ replyScheduled: true });
  });

  it('pushes a reply that would fall outside business hours to the next morning', async () => {
    account();
    const evening = new Date('2026-10-16T16:30:00Z'); // Friday 16:30 UTC; +130 minutes is 18:40
    await master.update(messages).set({ claimedAt: null }).where(eq(messages.id, 'm1'));

    await engage(['m1'], testEnv(), replyRolls(), evening);

    const [reply] = await replies();
    // Monday 09:00 UTC plus up to 90 minutes (the roll is 0.5: 45).
    expect(reply!.scheduledAt).toEqual(new Date('2026-10-19T09:45:00Z'));
  });
});

describe('logins', () => {
  it('a rejected login parks the recipient and retries the message 6 hours later without counting it', async () => {
    routeImap(connectMock, { [B1]: new ImapError('auth', 'LOGIN rejected', { command: 'LOGIN', response: 'NO [AUTHENTICATIONFAILED] Invalid credentials' }) });
    const index = createDueIndex();

    const batch = await engage(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(await mailbox('b1')).toMatchObject({
      status: 'error',
      pausedReason: 'login_failed',
      lastLoginError: 'imap: NO [AUTHENTICATIONFAILED] Invalid credentials',
      lastLoginErrorAt: NOW,
    });
    expect(await row()).toMatchObject({
      status: 'sent',
      engageAttempts: 0,
      engageAt: new Date(NOW.getTime() + LOGIN_RETRY_MS),
      claimedAt: null,
    });
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(await dueAt(index, 'org_b1')).toBe(NOW.getTime());
    expect(await mailbox('a1')).toMatchObject({ status: 'warming' });
  });

  it('a working login clears the recipient login error', async () => {
    await master.update(pool).set({ lastLoginError: 'imap: old', lastLoginErrorAt: NOW }).where(eq(pool.id, 'b1'));
    account();
    const index = createDueIndex();

    await engage(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(await mailbox('b1')).toMatchObject({ lastLoginError: null, lastLoginErrorAt: null, status: 'warming' });
    expect(await dueAt(index, 'org_b1')).toBe(NOW.getTime());
  });

  it('does not touch the schedule index when there was no error to clear', async () => {
    account();
    const index = createDueIndex();

    await engage(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(await dueAt(index, 'org_b1')).toBeNull();
  });

  it('parks a recipient whose sealed login cannot be opened', async () => {
    await master.update(pool).set({ imapCredentials: 'garbage' }).where(eq(pool.id, 'b1'));
    const index = createDueIndex();

    await engage(['m1'], testEnv({ SCHEDULE_INDEX: index }));

    expect(connectMock).not.toHaveBeenCalled();
    expect(await mailbox('b1')).toMatchObject({ status: 'paused', pausedReason: 'credentials_unavailable', lastLoginError: 'credentials_unavailable' });
    expect(await row()).toMatchObject({ status: 'sent', engageAt: new Date(NOW.getTime() + LOGIN_RETRY_MS) });
    expect(await dueAt(index, 'org_b1')).toBe(NOW.getTime());
  });

  it('a connection error counts as an attempt, retries soon and never ends as missing', async () => {
    routeImap(connectMock, { [B1]: new ImapError('connect', 'connection dropped') });

    await engage();
    expect(await row()).toMatchObject({
      status: 'sent',
      engageAttempts: 1,
      engageAt: new Date(NOW.getTime() + TRANSIENT_RETRY_MS),
    });
    await engage();
    await engage();

    expect(await row()).toMatchObject({ status: 'failed', placement: null });
    expect((await row()).error).toContain('imap_connect');
    expect(await mailbox('b1')).toMatchObject({ status: 'warming' });
  });

  it('logs out when a command fails mid-way', async () => {
    const imap = account();
    const session = imap.session();
    session.searchByMessageId = async () => {
      throw new ImapError('command', 'SEARCH failed', { command: 'UID SEARCH', response: 'NO' });
    };
    connectMock.mockResolvedValue(session);

    await engage();

    expect(imap.loggedOut).toBe(true);
    expect(await row()).toMatchObject({ status: 'sent', engageAttempts: 1 });
  });

  it('retries the queue message on an unexpected error', async () => {
    const imap = account();
    const session = imap.session();
    session.select = async () => {
      throw new Error('bug');
    };
    connectMock.mockResolvedValue(session);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const batch = await engage();

    expect(batch.messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(batch.messages[0]!.ack).not.toHaveBeenCalled();
    expect(imap.loggedOut).toBe(true);
    error.mockRestore();
  });
});

describe('recipients that are not active', () => {
  it('waits 6 hours for a paused recipient without counting an attempt', async () => {
    await master.update(pool).set({ status: 'paused', pausedReason: 'paused_by_user' }).where(eq(pool.id, 'b1'));

    await engage();

    expect(connectMock).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'sent', engageAttempts: 0, engageAt: new Date(NOW.getTime() + LOGIN_RETRY_MS) });
    expect(await mailbox('b1')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
  });

  it('gives up on a recipient that stays inactive for two days', async () => {
    await master.update(pool).set({ status: 'paused' }).where(eq(pool.id, 'b1'));
    await master
      .update(messages)
      .set({ sentAt: new Date(NOW.getTime() - INACTIVE_GIVE_UP_MS - 60_000) })
      .where(eq(messages.id, 'm1'));

    await engage();

    expect(await row()).toMatchObject({ status: 'failed', error: 'mailbox_inactive', placement: null });
  });

  it('fails the message of a removed recipient at once', async () => {
    await master.update(pool).set({ status: 'removed' }).where(eq(pool.id, 'b1'));

    await engage();

    expect(await row()).toMatchObject({ status: 'failed', error: 'mailbox_inactive' });
  });
});

describe('queue handling', () => {
  it('drops a queue message without a messageId instead of retrying it forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const batch = fakeBatch<unknown>('reach-warmup-engage-test', [{}, { messageId: '' }, 'junk']);

    await handleEngageBatch(batch as unknown as MessageBatch<WarmupEngageMessage>, testEnv(), FAKE_CTX, { db: master, now: () => NOW });

    expect(batch.messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true);
    expect(batch.messages.every((message) => message.retry.mock.calls.length === 0)).toBe(true);
    expect(connectMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips a message that is not in the sent state', async () => {
    account();
    await master.update(messages).set({ status: 'engaged' }).where(eq(messages.id, 'm1'));

    const batch = await engage();

    expect(connectMock).not.toHaveBeenCalled();
    expect(batch.messages[0]!.ack).toHaveBeenCalledTimes(1);
  });

  it('engages once when two consumers get the message', async () => {
    account();
    const env = testEnv();

    await Promise.all([engage(['m1'], env, noReplyRolls()), engage(['m1'], env, noReplyRolls())]);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect((await row()).status).toBe('engaged');
  });

  it('does nothing while the kill switch is off and hands the claim back', async () => {
    account();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const batch = await engage(['m1'], testEnv({ FLAGSHIP: flagship(false) }));

    expect(connectMock).not.toHaveBeenCalled();
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: 'sent', claimedAt: null });
    log.mockRestore();
  });
});
