/**
 * Cleanup against a pglite master DB and scripted IMAP accounts: what is
 * deleted where, the per-run bounds, unreachable mailboxes, row retention.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ImapError, connectImap } from '@weldsuite/imap';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  CLEANUP_MAX_IDS_PER_MAILBOX,
  CLEANUP_MAX_MAILBOXES,
  ROW_RETENTION_DAYS,
  planCleanup,
  runCleanup,
  type CleanupCandidate,
} from './cleanup';
import {
  FakeImapAccount,
  createDueIndex,
  dueAt,
  messages,
  pool,
  resetMaster,
  routeImap,
  seedMailbox,
  seedMessage,
  testEnv,
} from './test-support/fixtures';

vi.mock('@weldsuite/imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/imap')>()),
  connectImap: vi.fn(),
}));

const NOW = new Date('2026-10-13T02:30:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const connectMock = vi.mocked(connectImap);

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  connectMock.mockReset();
});

const row = async (id: string) => (await master.select().from(messages).where(eq(messages.id, id)))[0]!;
const mailbox = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;

function old(id: string, from: string, to: string, overrides: Partial<typeof messages.$inferInsert> = {}) {
  return seedMessage(master, {
    id,
    fromMailboxId: from,
    toMailboxId: to,
    messageIdHeader: `${id}@${from}.test`,
    status: 'engaged',
    placement: 'inbox',
    sentAt: daysAgo(15),
    scheduledAt: daysAgo(15),
    ...overrides,
  });
}

/** Both sides of a pair as scripted accounts: the recipient's INBOX and the sender's Sent folder. */
function pairAccounts(ids: string[], options: { trash?: boolean } = {}) {
  const special: Record<string, string> = { '\\Sent': 'Sent' };
  if (options.trash !== false) special['\\Trash'] = 'Trash';
  const recipient = new FakeImapAccount({ special });
  const sender = new FakeImapAccount({ special });
  for (const id of ids) {
    recipient.put('INBOX', `${id}@a1.test`);
    sender.put('Sent', `${id}@a1.test`);
  }
  routeImap(connectMock, { 'a1@a1.test': sender, 'b1@b1.test': recipient });
  return { recipient, sender };
}

describe('deleting old warmup mail', () => {
  beforeEach(async () => {
    await seedMailbox(master, { id: 'a1' });
    await seedMailbox(master, { id: 'b1' });
  });

  it('removes old engaged and missing messages from the recipient inbox and the sender Sent folder', async () => {
    await old('o1', 'a1', 'b1');
    await old('o2', 'a1', 'b1', { status: 'missing', placement: 'missing' });
    await old('recent', 'a1', 'b1', { sentAt: daysAgo(5), scheduledAt: daysAgo(5) });
    const { recipient, sender } = pairAccounts(['o1', 'o2', 'recent']);

    const result = await runCleanup(testEnv(), master, NOW);

    expect(result).toMatchObject({ cleaned: 2, mailboxesVisited: 2, rowsDeleted: 0 });
    expect(recipient.folders.INBOX!.map((m) => m.messageId)).toEqual(['recent@a1.test']);
    expect(sender.folders.Sent!.map((m) => m.messageId)).toEqual(['recent@a1.test']);
    expect((await row('o1')).cleanedAt).toEqual(NOW);
    expect((await row('o2')).cleanedAt).toEqual(NOW);
    expect((await row('recent')).cleanedAt).toBeNull();
    expect(recipient.loggedOut && sender.loggedOut).toBe(true);
  });

  it('moves mail to Trash and deletes it there, so Gmail drops it instead of archiving it', async () => {
    await old('o1', 'a1', 'b1');
    const { recipient } = pairAccounts(['o1']);

    await runCleanup(testEnv(), master, NOW);

    expect(recipient.calls).toEqual(expect.arrayContaining(['move Trash', 'select Trash', 'delete Trash']));
    expect(recipient.folders.INBOX).toEqual([]);
    expect(recipient.folders.Trash).toEqual([]);
  });

  it('deletes in place when the account has no Trash folder', async () => {
    await old('o1', 'a1', 'b1');
    const { recipient, sender } = pairAccounts(['o1'], { trash: false });

    await runCleanup(testEnv(), master, NOW);

    expect(recipient.calls.some((call) => call.startsWith('move'))).toBe(false);
    expect(recipient.calls).toContain('delete INBOX');
    expect(sender.calls).toContain('delete Sent');
    expect(recipient.folders.INBOX).toEqual([]);
    expect((await row('o1')).cleanedAt).toEqual(NOW);
  });

  it('cleans a message that is already gone from a mailbox', async () => {
    await old('o1', 'a1', 'b1');
    const { recipient } = pairAccounts([]);
    expect(recipient.folders.INBOX).toEqual([]);

    await runCleanup(testEnv(), master, NOW);

    expect((await row('o1')).cleanedAt).toEqual(NOW);
  });

  it('leaves failed, unengaged, already cleaned and recent messages alone', async () => {
    await old('failed', 'a1', 'b1', { status: 'failed', placement: null, sentAt: null });
    await old('unengaged', 'a1', 'b1', { status: 'sent', placement: null });
    await old('done', 'a1', 'b1', { cleanedAt: daysAgo(1) });
    await old('recent', 'a1', 'b1', { sentAt: daysAgo(13) });
    pairAccounts([]);

    const result = await runCleanup(testEnv(), master, NOW);

    expect(result.cleaned).toBe(0);
    expect(connectMock).not.toHaveBeenCalled();
    expect((await row('done')).cleanedAt).toEqual(daysAgo(1));
  });

  it('finishes a message only when both sides were cleaned', async () => {
    await old('o1', 'a1', 'b1');
    const { sender } = pairAccounts(['o1']);
    routeImap(connectMock, {
      'a1@a1.test': sender,
      'b1@b1.test': new ImapError('auth', 'LOGIN rejected', { response: 'NO bad password' }),
    });
    const index = createDueIndex();

    const result = await runCleanup(testEnv({ SCHEDULE_INDEX: index }), master, NOW);

    expect(result.cleaned).toBe(0);
    expect((await row('o1')).cleanedAt).toBeNull();
    expect(sender.folders.Sent).toEqual([]);
    expect(await mailbox('b1')).toMatchObject({ status: 'error', pausedReason: 'login_failed', lastLoginError: 'imap: NO bad password' });
    expect(await dueAt(index, 'org_b1')).toBe(NOW.getTime());
    expect(await mailbox('a1')).toMatchObject({ status: 'warming' });
  });

  it('skips a connection that drops and tries again next run, without blaming the mailbox', async () => {
    await old('o1', 'a1', 'b1');
    const { sender } = pairAccounts(['o1']);
    routeImap(connectMock, { 'a1@a1.test': sender, 'b1@b1.test': new ImapError('connect', 'dropped') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runCleanup(testEnv(), master, NOW);

    expect((await row('o1')).cleanedAt).toBeNull();
    expect(await mailbox('b1')).toMatchObject({ status: 'warming', lastLoginError: null });
    warn.mockRestore();
  });

  it('a working login clears an earlier login error', async () => {
    await master.update(pool).set({ lastLoginError: 'imap: old', lastLoginErrorAt: daysAgo(1) }).where(eq(pool.id, 'b1'));
    await old('o1', 'a1', 'b1');
    pairAccounts(['o1']);

    await runCleanup(testEnv(), master, NOW);

    expect(await mailbox('b1')).toMatchObject({ lastLoginError: null, lastLoginErrorAt: null });
  });

  it('marks messages of a removed mailbox done without any IMAP session', async () => {
    await seedMailbox(master, { id: 'gone', status: 'removed' });
    await old('o1', 'a1', 'gone');
    await old('o2', 'gone', 'b1');

    const result = await runCleanup(testEnv(), master, NOW);

    expect(connectMock).not.toHaveBeenCalled();
    expect(result.cleaned).toBe(0);
    expect((await row('o1')).cleanedAt).toEqual(NOW);
    expect((await row('o2')).cleanedAt).toEqual(NOW);
  });

  it('leaves messages of a mailbox in error until it is fixed, and does not let them crowd the run', async () => {
    await seedMailbox(master, { id: 'broken', status: 'error' });
    await old('stuck', 'a1', 'broken', { sentAt: daysAgo(30) });
    await old('fine', 'a1', 'b1');
    pairAccounts(['fine']);

    const result = await runCleanup(testEnv(), master, NOW);

    expect(result.cleaned).toBe(1);
    expect((await row('stuck')).cleanedAt).toBeNull();
    expect((await row('fine')).cleanedAt).toEqual(NOW);
  });

  it('cleans paused mailboxes too (their logins still work)', async () => {
    await master.update(pool).set({ status: 'paused', pausedReason: 'paused_by_user' }).where(eq(pool.id, 'b1'));
    await old('o1', 'a1', 'b1');
    pairAccounts(['o1']);

    await runCleanup(testEnv(), master, NOW);

    expect((await row('o1')).cleanedAt).toEqual(NOW);
    expect(await mailbox('b1')).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });
  });
});

describe('bounds', () => {
  it(`opens at most ${CLEANUP_MAX_MAILBOXES} mailboxes in one run and leaves the rest for the next`, async () => {
    // 40 mailboxes, 20 old messages: x_i -> x_(i+20). Each message touches two mailboxes.
    const ids = Array.from({ length: 40 }, (_, i) => `x${i}`);
    for (const id of ids) await seedMailbox(master, { id });
    const accounts: Record<string, FakeImapAccount> = {};
    for (const id of ids) {
      accounts[`${id}@${id}.test`] = new FakeImapAccount({ special: { '\\Sent': 'Sent' } });
    }
    for (let i = 0; i < 20; i++) {
      const sender = ids[i]!;
      const recipient = ids[i + 20]!;
      await old(`m${i}`, sender, recipient, { sentAt: daysAgo(60 - i) });
      accounts[`${sender}@${sender}.test`]!.put('Sent', `m${i}@${sender}.test`);
      accounts[`${recipient}@${recipient}.test`]!.put('INBOX', `m${i}@${sender}.test`);
    }
    routeImap(connectMock, accounts);

    const first = await runCleanup(testEnv(), master, NOW);

    expect(connectMock).toHaveBeenCalledTimes(CLEANUP_MAX_MAILBOXES);
    expect(first).toMatchObject({ cleaned: 15, mailboxesVisited: CLEANUP_MAX_MAILBOXES });
    // Oldest first.
    expect((await row('m0')).cleanedAt).toEqual(NOW);
    expect((await row('m19')).cleanedAt).toBeNull();

    connectMock.mockClear();
    const second = await runCleanup(testEnv(), master, NOW);
    expect(second.cleaned).toBe(5);
    expect(connectMock.mock.calls.length).toBeLessThanOrEqual(CLEANUP_MAX_MAILBOXES);
  });

  it('planCleanup picks whole messages, oldest first, within the mailbox and id bounds', () => {
    const candidate = (id: string, from: string, to: string): CleanupCandidate => ({
      id,
      fromMailboxId: from,
      toMailboxId: to,
      messageIdHeader: `${id}@${from}.test`,
    });

    const plan = planCleanup([candidate('1', 'a', 'b'), candidate('2', 'c', 'd'), candidate('3', 'e', 'f'), candidate('4', 'a', 'd')], 4, 10);

    // Two pairs fill 4 mailboxes; the third pair needs two new ones; the fourth reuses a and d.
    expect(plan.selected.map((m) => m.id)).toEqual(['1', '2', '4']);
    expect([...plan.work.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.work.get('b')).toEqual({ inbox: ['1@a.test'], sent: [] });
    expect(plan.work.get('a')).toEqual({ inbox: [], sent: ['1@a.test', '4@a.test'] });

    const capped = planCleanup([candidate('1', 'a', 'b'), candidate('2', 'a', 'c'), candidate('3', 'a', 'd')], 10, 2);
    expect(capped.selected.map((m) => m.id)).toEqual(['1', '2']);
    expect(CLEANUP_MAX_IDS_PER_MAILBOX).toBeGreaterThan(0);
  });
});

describe('row retention', () => {
  it(`deletes message rows older than ${ROW_RETENTION_DAYS} days`, async () => {
    await seedMailbox(master, { id: 'a1' });
    await seedMailbox(master, { id: 'b1' });
    await old('ancient', 'a1', 'b1', { createdAt: daysAgo(ROW_RETENTION_DAYS + 1), cleanedAt: daysAgo(10) });
    await old('failed-ancient', 'a1', 'b1', { createdAt: daysAgo(40), status: 'failed', placement: null, sentAt: null });
    await old('kept', 'a1', 'b1', { createdAt: daysAgo(ROW_RETENTION_DAYS - 1), cleanedAt: daysAgo(10) });

    const result = await runCleanup(testEnv(), master, NOW);

    expect(result.rowsDeleted).toBe(2);
    expect((await master.select().from(messages)).map((m) => m.id)).toEqual(['kept']);
  });
});
