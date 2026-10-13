/**
 * Slot reconciliation: the math (pure) and the run against the master DB only.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { MailpoolError } from '../lib/mailpool/errors';
import { createFakeMailpool } from '../lib/mailpool/testing';
import { resetReachMaster } from '../lib/mailpool/testing-db';
import { computeSlotAdjustments, ensureSlotAvailable, SLOT_SURPLUS_TOLERANCE } from '../services/slots';
import type { Env } from '../types';
import { activeMailboxesByType, runSlotReconciliation } from './slot-reconciliation';

describe('computeSlotAdjustments', () => {
  const slots = (s: Record<string, number>, m: Record<string, number> = {}) => ({ slots: s, mailboxes: m });

  it('gives back the surplus only when it exceeds the tolerance', () => {
    expect(SLOT_SURPLUS_TOLERANCE).toBe(2);
    const [exact] = computeSlotAdjustments({ google: 10 }, slots({ google: 10 }));
    const [within] = computeSlotAdjustments({ google: 10 }, slots({ google: 12 }));
    const [over] = computeSlotAdjustments({ google: 10 }, slots({ google: 13 }));

    expect(exact).toMatchObject({ surplus: 0, decreaseBy: 0 });
    expect(within).toMatchObject({ surplus: 2, decreaseBy: 0 });
    expect(over).toMatchObject({ type: 'google', need: 10, slots: 13, surplus: 3, decreaseBy: 3 });
  });

  it('works per type and treats a type with no mailboxes as need 0', () => {
    const result = computeSlotAdjustments({ google: 4 }, slots({ google: 4, private: 5, outlook: 0 }));
    const byType = Object.fromEntries(result.map((a) => [a.type, a]));

    expect(byType.google!.decreaseBy).toBe(0);
    expect(byType.private).toMatchObject({ need: 0, surplus: 5, decreaseBy: 5 });
    expect(byType.outlook!.decreaseBy).toBe(0);
  });

  it('never tops up a shortage, but reports it as drift', () => {
    const [short] = computeSlotAdjustments({ google: 8 }, slots({ google: 5 }));
    expect(short).toMatchObject({ surplus: -3, decreaseBy: 0, drift: true });
  });

  it('flags drift when Mailpool counts another number of mailboxes than we do', () => {
    const [agrees] = computeSlotAdjustments({ google: 4 }, slots({ google: 5 }, { google: 4 }));
    const [differs] = computeSlotAdjustments({ google: 4 }, slots({ google: 5 }, { google: 6 }));
    const [unknown] = computeSlotAdjustments({ google: 4 }, slots({ google: 5 }));

    expect(agrees!.drift).toBe(false);
    expect(differs).toMatchObject({ drift: true, usedAtMailpool: 6 });
    expect(unknown).toMatchObject({ drift: false, usedAtMailpool: null });
  });

  it('only looks at types Mailpool reports slots for (shared has none)', () => {
    const result = computeSlotAdjustments({ shared: 12, google: 1 }, slots({ google: 1 }));
    expect(result.map((a) => a.type)).toEqual(['google']);
  });
});

describe('ensureSlotAvailable', () => {
  it('does nothing while a slot is free, adds one when full, and ignores types without slots', async () => {
    const free = createFakeMailpool({ getSlots: async () => ({ mailboxes: { google: 3 }, slots: { google: 5 } }) });
    expect(await ensureSlotAvailable(free, 'google')).toEqual({ managed: true, increased: false });
    expect(free.increaseSlots).not.toHaveBeenCalled();

    const full = createFakeMailpool({ getSlots: async () => ({ mailboxes: { google: 5 }, slots: { google: 5 } }) });
    expect(await ensureSlotAvailable(full, 'google')).toEqual({ managed: true, increased: true });
    expect(full.increaseSlots).toHaveBeenCalledExactlyOnceWith('google', 1);

    const noShared = createFakeMailpool();
    expect(await ensureSlotAvailable(noShared, 'shared')).toEqual({ managed: false, increased: false });
    expect(noShared.increaseSlots).not.toHaveBeenCalled();
  });

  it('adds a slot when Mailpool reports no usage count (treated as zero used, so only a zero total adds)', async () => {
    const empty = createFakeMailpool({ getSlots: async () => ({ mailboxes: {}, slots: { google: 0 } }) });
    expect(await ensureSlotAvailable(empty, 'google')).toEqual({ managed: true, increased: true });
  });
});

describe('runSlotReconciliation', () => {
  let master: MasterDatabase;

  beforeAll(async () => {
    master = (await createMasterPgliteDb()).db as MasterDatabase;
  }, 120_000);

  beforeEach(async () => {
    await resetReachMaster(master);
  });

  async function route(id: string, kind: 'mailpool_mailbox' | 'inbound_token' | 'mailpool_domain', type: string | null, status: 'active' | 'deleted' = 'active') {
    await master.insert(masterSchema.reachRoutes).values({
      id: `rrt_${id}`,
      kind,
      externalId: id,
      workspaceId: `ws_${id}`,
      clerkOrgId: `org_${id}`,
      tenantEntityId: `rmbx_${id}`,
      mailboxType: type,
      status,
    });
  }

  const env = { MAILPOOL_API_KEY: 'k' } as unknown as Env;

  it('counts only active mailbox routes, per type', async () => {
    await route('1', 'mailpool_mailbox', 'google');
    await route('2', 'mailpool_mailbox', 'google');
    await route('3', 'mailpool_mailbox', 'shared');
    await route('4', 'mailpool_mailbox', 'google', 'deleted');
    await route('5', 'inbound_token', 'google');
    await route('6', 'mailpool_domain', null);

    expect(await activeMailboxesByType(master)).toEqual({ google: 2, shared: 1 });
  });

  it('decreases surplus slots beyond the tolerance and reports what it did', async () => {
    for (const id of ['1', '2', '3']) await route(id, 'mailpool_mailbox', 'google');
    const mailpool = createFakeMailpool({ getSlots: async () => ({ mailboxes: { google: 3 }, slots: { google: 10, private: 1 } }) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const report = await runSlotReconciliation(env, { master, mailpool });

    expect(mailpool.decreaseSlots).toHaveBeenCalledExactlyOnceWith('google', 7);
    expect(report).toMatchObject({ need: { google: 3 }, decreased: { google: 7 }, failed: [] });
    // $4 x 3 at Mailpool against $5 x 3 from customers.
    expect(report).toMatchObject({ monthlyCostCents: 1200, monthlyRevenueCents: 1500 });
    log.mockRestore();
  });

  it('leaves slots alone within the tolerance and warns about drift', async () => {
    for (const id of ['1', '2']) await route(id, 'mailpool_mailbox', 'google');
    const mailpool = createFakeMailpool({ getSlots: async () => ({ mailboxes: { google: 4 }, slots: { google: 4 } }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const report = await runSlotReconciliation(env, { master, mailpool });

    expect(mailpool.decreaseSlots).not.toHaveBeenCalled();
    expect(report?.decreased).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('drift for google: need=2 slots=4 usedAtMailpool=4'));
    warn.mockRestore();
    log.mockRestore();
  });

  it('keeps going and reports the type when one decrease fails', async () => {
    const mailpool = createFakeMailpool({ getSlots: async () => ({ mailboxes: {}, slots: { google: 5, private: 4 } }) });
    mailpool.decreaseSlots.mockRejectedValueOnce(new MailpoolError({ method: 'POST', path: '/subscriptions/decrease', status: 502 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const report = await runSlotReconciliation(env, { master, mailpool });

    expect(mailpool.decreaseSlots).toHaveBeenCalledTimes(2);
    expect(report?.failed).toEqual(['google']);
    expect(report?.decreased).toEqual({ private: 4 });
    error.mockRestore();
    log.mockRestore();
  });

  it('does nothing without a Mailpool key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runSlotReconciliation({} as Env, { master })).toBeNull();
    warn.mockRestore();
  });
});
