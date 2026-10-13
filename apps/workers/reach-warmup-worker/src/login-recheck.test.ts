/**
 * Login recheck against a pglite master DB and scripted IMAP accounts: which
 * mailboxes are tried, what a working login restores, and what is never touched.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ImapError, connectImap } from '@weldsuite/imap';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { loadCorpus } from './corpus';
import { RECHECK_BACKOFF_MS, RECHECK_LIMIT, recheckLogins } from './login-recheck';
import { resetKillSwitchLog } from './lib/flag';
import { runPlannerTick } from './planner';
import {
  FakeImapAccount,
  createDueIndex,
  dueAt,
  pool,
  resetMaster,
  routeImap,
  seedMailbox,
  seeded,
  testEnv,
} from './test-support/fixtures';

vi.mock('./corpus', () => import('./test-support/corpus-stub'));
vi.mock('@weldsuite/imap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/imap')>()),
  connectImap: vi.fn(),
}));

const NOW = new Date('2026-10-13T10:00:00Z');
const connectMock = vi.mocked(connectImap);
const HOURS = 3_600_000;

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetMaster(master);
  resetKillSwitchLog();
  connectMock.mockReset();
  vi.mocked(loadCorpus).mockClear();
});

const mailbox = async (id: string) => (await master.select().from(pool).where(eq(pool.id, id)))[0]!;
const login = (id: string) => `${id}@${id}.test`;
const works = (...ids: string[]) => routeImap(connectMock, Object.fromEntries(ids.map((id) => [login(id), new FakeImapAccount()])));

function broken(id: string, overrides: Partial<typeof pool.$inferInsert> = {}) {
  return seedMailbox(master, {
    id,
    status: 'error',
    pausedReason: 'login_failed',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    rampDay: 5,
    lastLoginError: 'imap: NO invalid credentials',
    lastLoginErrorAt: new Date(NOW.getTime() - RECHECK_BACKOFF_MS - HOURS),
    ...overrides,
  });
}

describe('bringing mailboxes back', () => {
  it('restores a mailbox whose login works again to where its warmup had got to', async () => {
    await broken('warm', { rampDay: 5 });
    await broken('maint', { rampDay: 20 });
    await broken('fresh', { startedAt: null, rampDay: 0 });
    works('warm', 'maint', 'fresh');
    const index = createDueIndex();

    const result = await recheckLogins({ ...testEnv(), SCHEDULE_INDEX: index }, master, NOW);

    expect(result).toEqual({ checked: 3, healed: 3 });
    for (const [id, status] of [['warm', 'warming'], ['maint', 'maintaining'], ['fresh', 'waiting']] as const) {
      expect(await mailbox(id)).toMatchObject({ status, pausedReason: null, lastLoginError: null, lastLoginErrorAt: null });
      expect(await dueAt(index, `org_${id}`)).toBe(NOW.getTime());
    }
  });

  it('retries right away after reach-api registered new logins (it clears the error text)', async () => {
    await broken('new', { lastLoginError: null, lastLoginErrorAt: null });
    works('new');

    expect(await recheckLogins(testEnv(), master, NOW)).toEqual({ checked: 1, healed: 1 });
    expect((await mailbox('new')).status).toBe('warming');
  });

  it('keeps a mailbox out while its login still fails, and backs off for 6 hours', async () => {
    await broken('still');
    routeImap(connectMock, { [login('still')]: new ImapError('auth', 'LOGIN rejected', { response: 'NO still wrong' }) });
    const index = createDueIndex();

    const first = await recheckLogins({ ...testEnv(), SCHEDULE_INDEX: index }, master, NOW);

    expect(first).toEqual({ checked: 1, healed: 0 });
    expect(await mailbox('still')).toMatchObject({
      status: 'error',
      pausedReason: 'login_failed',
      lastLoginError: 'imap: NO still wrong',
      lastLoginErrorAt: NOW,
    });
    // reach-api already knew about the error: no new tenant visit.
    expect(await dueAt(index, 'org_still')).toBeNull();

    const soon = await recheckLogins(testEnv(), master, new Date(NOW.getTime() + HOURS));
    expect(soon.checked).toBe(0);
    const later = await recheckLogins(testEnv(), master, new Date(NOW.getTime() + RECHECK_BACKOFF_MS + 1));
    expect(later.checked).toBe(1);
  });

  it('tells reach-api when a re-registered mailbox fails again for the first time', async () => {
    await broken('new', { lastLoginError: null, lastLoginErrorAt: null });
    routeImap(connectMock, { [login('new')]: new ImapError('connect', 'timed out') });
    const index = createDueIndex();

    await recheckLogins({ ...testEnv(), SCHEDULE_INDEX: index }, master, NOW);

    expect(await mailbox('new')).toMatchObject({ status: 'error', lastLoginError: 'imap: timed out', lastLoginErrorAt: NOW });
    expect(await dueAt(index, 'org_new')).toBe(NOW.getTime());
  });

  it('backs off a mailbox whose credentials still cannot be opened', async () => {
    await broken('sealed', { imapCredentials: 'garbage' });

    expect(await recheckLogins(testEnv(), master, NOW)).toEqual({ checked: 1, healed: 0 });

    expect(connectMock).not.toHaveBeenCalled();
    expect(await mailbox('sealed')).toMatchObject({
      status: 'error',
      pausedReason: 'login_failed',
      lastLoginError: 'imap: credentials_unavailable',
      lastLoginErrorAt: NOW,
    });
    expect((await recheckLogins(testEnv(), master, new Date(NOW.getTime() + HOURS))).checked).toBe(0);
  });
});

describe('what is never touched', () => {
  it('leaves an SMTP login failure until the logins are registered again', async () => {
    await broken('smtp', { lastLoginError: 'smtp: 535 5.7.8 bad credentials' });
    works('smtp');

    expect((await recheckLogins(testEnv(), master, NOW)).checked).toBe(0);
    expect((await mailbox('smtp')).status).toBe('error');
  });

  it.each(['paused_by_user', 'paused_by_staff', 'mailbox_suspended', 'domain_inactive', 'domain_error', 'low_inbox_rate', 'credentials_unavailable'])(
    'leaves a mailbox paused for %s',
    async (reason) => {
      await seedMailbox(master, { id: 'other', status: 'paused', pausedReason: reason, lastLoginError: null, lastLoginErrorAt: null });
      works('other');

      expect((await recheckLogins(testEnv(), master, NOW)).checked).toBe(0);
      expect(await mailbox('other')).toMatchObject({ status: 'paused', pausedReason: reason });
    },
  );

  it('leaves an errored mailbox with another reason alone', async () => {
    await seedMailbox(master, { id: 'other', status: 'error', pausedReason: 'domain_error', lastLoginError: null });
    works('other');

    expect((await recheckLogins(testEnv(), master, NOW)).checked).toBe(0);
  });

  it(`tries at most ${RECHECK_LIMIT} mailboxes per run`, async () => {
    const ids = Array.from({ length: RECHECK_LIMIT + 5 }, (_, i) => `m${i}`);
    for (const id of ids) await broken(id);
    works(...ids);

    const first = await recheckLogins(testEnv(), master, NOW);
    const second = await recheckLogins(testEnv(), master, NOW);

    expect(first).toEqual({ checked: RECHECK_LIMIT, healed: RECHECK_LIMIT });
    expect(second).toEqual({ checked: 5, healed: 5 });
  });

  it('logs out of every session it opened', async () => {
    await broken('one');
    const account = new FakeImapAccount();
    routeImap(connectMock, { [login('one')]: account });

    await recheckLogins(testEnv(), master, NOW);

    expect(account.loggedOut).toBe(true);
  });
});

describe('with the planner', () => {
  it('runs first, so a restored mailbox is planned in the same tick', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 3 });
    await seedMailbox(master, { id: 'b1', rampDay: 3 });
    await broken('c1', { rampDay: 3 });
    works('c1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runPlannerTick(testEnv(), { db: master, now: () => NOW, random: seeded(1) });

    expect(result.loginsRestored).toBe(1);
    expect(result.poolDomains).toBe(3);
    expect(result.status).toBe('ok');
    log.mockRestore();
  });

  it('does not stop the planner when the recheck fails', async () => {
    await seedMailbox(master, { id: 'a1', rampDay: 3 });
    await seedMailbox(master, { id: 'b1', rampDay: 3 });
    await seedMailbox(master, { id: 'c1', rampDay: 3 });
    await broken('d1');
    connectMock.mockRejectedValue(new Error('unexpected'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runPlannerTick(testEnv(), { db: master, now: () => NOW, random: seeded(1) });

    expect(result.status).toBe('ok');
    expect(result.messagesPlanned).toBeGreaterThan(0);
    warn.mockRestore();
    log.mockRestore();
  });
});
