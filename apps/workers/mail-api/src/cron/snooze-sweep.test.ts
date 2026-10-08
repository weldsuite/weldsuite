import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';

const tenantDbFor = vi.fn(async (_env: unknown, orgId: string) => ({ orgId }));
const mailWorkspaces = vi.fn(async () => [{ clerkOrgId: 'org_a' }, { clerkOrgId: 'org_b' }]);

vi.mock('@weldsuite/worker-kit/db', () => ({
  getTenantDbForWorkspace: (env: unknown, orgId: string) => tenantDbFor(env, orgId),
  getMasterDb: () => ({
    selectDistinct: () => ({ from: () => ({ innerJoin: () => ({ where: () => mailWorkspaces() }) }) }),
  }),
  masterSchema: {
    mailAccountRegistry: { workspaceId: 'workspace_id', tenantKind: 'tenant_kind', isActive: 'is_active' },
    workspaces: { id: 'id', clerkOrgId: 'clerk_org_id', isActive: 'is_active' },
  },
}));

const woken = new Map<string, number>();
const nextDue = new Map<string, Date | null>();
vi.mock('@weldsuite/mail-domain/snooze', () => ({
  wakeDueSnoozedMessages: vi.fn(async (db: { orgId: string }) => ({ woken: woken.get(db.orgId) ?? 0, accountIds: [] })),
  nextSnoozeDueAt: vi.fn(async (db: { orgId: string }) => nextDue.get(db.orgId) ?? null),
}));

import { isSnoozeSweepCron, runSnoozeSweep, SNOOZE_INDEX_SEED_KEY, SNOOZE_SWEEP_CRONS } from './snooze-sweep';

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql',
  ),
  'utf8',
);

const T0 = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
const HOUR = 3_600_000;

function makeEnv(seeded: boolean) {
  const kv = createMemoryKv();
  if (seeded) kv.store.set(SNOOZE_INDEX_SEED_KEY, 'done');
  return { SCHEDULE_INDEX: createSqliteD1(MIGRATION), WORKSPACE_CACHE: kv };
}

describe('isSnoozeSweepCron', () => {
  it('runs on the 5-minute cadence only', () => {
    expect(SNOOZE_SWEEP_CRONS).toEqual(['*/5 * * * *']);
    expect(isSnoozeSweepCron('*/5 * * * *')).toBe(true);
    expect(isSnoozeSweepCron('0 * * * *')).toBe(false);
    expect(isSnoozeSweepCron('* * * * *')).toBe(false);
  });
});

describe('runSnoozeSweep', () => {
  beforeEach(() => {
    tenantDbFor.mockClear();
    mailWorkspaces.mockClear();
    woken.clear();
    nextDue.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens no tenant and no master DB on a quiet tick', async () => {
    const env = makeEnv(true);
    const res = await runSnoozeSweep(env as never, T0);
    expect(res).toMatchObject({ due: 0, processed: 0, woken: 0 });
    expect(tenantDbFor).not.toHaveBeenCalled();
    expect(mailWorkspaces).not.toHaveBeenCalled();
  });

  it('opens only workspaces whose snooze is due, then waits for their next one', async () => {
    const env = makeEnv(true);
    await markWorkspaceDue(env.SCHEDULE_INDEX, 'mail_snooze', 'org_due', T0.getTime() - 1);
    await markWorkspaceDue(env.SCHEDULE_INDEX, 'mail_snooze', 'org_later', T0.getTime() + HOUR);
    woken.set('org_due', 3);
    nextDue.set('org_due', new Date(T0.getTime() + 2 * HOUR));

    const res = await runSnoozeSweep(env as never, T0);
    expect(res).toMatchObject({ due: 1, processed: 1, woken: 3 });
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor).toHaveBeenCalledWith(env, 'org_due');

    // Nothing is due until org_later's snooze an hour from now.
    tenantDbFor.mockClear();
    await runSnoozeSweep(env as never, new Date(T0.getTime() + 30 * 60_000));
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('seeds every mailbox workspace once, then drops the ones with nothing snoozed', async () => {
    const env = makeEnv(false);
    nextDue.set('org_a', new Date(T0.getTime() + HOUR));

    const first = await runSnoozeSweep(env as never, T0);
    expect(first).toMatchObject({ seeded: 2, due: 2, processed: 2 });
    expect(env.WORKSPACE_CACHE.store.has(SNOOZE_INDEX_SEED_KEY)).toBe(true);

    tenantDbFor.mockClear();
    await runSnoozeSweep(env as never, new Date(T0.getTime() + HOUR));
    expect(mailWorkspaces).toHaveBeenCalledTimes(1);
    expect(tenantDbFor.mock.calls.map(([, orgId]) => orgId)).toEqual(['org_a']);
  });
});
