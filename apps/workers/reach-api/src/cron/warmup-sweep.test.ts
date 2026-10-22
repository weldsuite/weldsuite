/**
 * The warmup sweep on the real due-index helpers (in-memory SQLite D1), a
 * pglite tenant, a pglite master holding the warmup pool and a fake Mailpool:
 * it visits only due workspaces, stores when each next needs a visit, and
 * never opens a tenant that lost access.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { createFakeMailpool, mailpoolMailbox } from '../lib/mailpool/testing';
import {
  WARMUP_TEST_KEY,
  poolStats,
  resetReachMaster,
  resetReachTenant,
  seedHostDomain,
  seedMailbox,
  seedPoolMailbox,
  seedReachDomain,
} from '../lib/mailpool/testing-db';
import { approvedAccess } from '../lib/mailpool/testing-routes';
import type { Env } from '../types';
import { MAX_WORKSPACES_PER_RUN, runWarmupSweep, WARMUP_INDEX_SEED_KEY, type WarmupSweepDeps } from './warmup-sweep';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => {}) };
});
import { publishEntityEventRaw } from '@weldsuite/entity-events';
const published = publishEntityEventRaw as unknown as ReturnType<typeof vi.fn>;

const MIGRATION = readFileSync(resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');
// The daily cron fires at 03:15 UTC.
const CRON = new Date('2026-10-13T03:15:00Z');
const TOMORROW = Date.UTC(2026, 9, 14);

let db: Database;
let master: MasterDatabase;
let d1: D1Database;
let env: Env;

async function dueAt(workspaceId: string): Promise<number | null> {
  return d1
    .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_warmup' AND workspace_id = ?")
    .bind(workspaceId)
    .first<number>('next_due_at');
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  published.mockClear();
  await resetReachTenant(db);
  await resetReachMaster(master);
  await seedHostDomain(db, { id: 'dom_1', fullDomain: 'getacme.com' });
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
  d1 = createSqliteD1(MIGRATION);
  env = {
    SCHEDULE_INDEX: d1,
    WORKSPACE_CACHE: createMemoryKv(),
    MAILPOOL_API_KEY: 'k',
    DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
    WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY,
  } as unknown as Env;
});

function sweepDeps(overrides: Pick<WarmupSweepDeps, 'openTenant' | 'readAccess'> = {}) {
  return {
    mailpool: createFakeMailpool(),
    master,
    openTenant: overrides.openTenant ?? vi.fn(async () => db),
    readAccess: overrides.readAccess ?? vi.fn(async () => approvedAccess()),
    now: CRON,
  };
}

describe('runWarmupSweep', () => {
  it('visits a due workspace, advances its mailboxes from the pool and stores tomorrow as the next visit', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming', mailpoolMailboxId: '341', email: 'jane@getacme.com' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'maintaining', rampDay: 14, stats: poolStats({ inboxRate3d: 0.9 }) });
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 3_600_000);
    const deps = sweepDeps();

    const result = await runWarmupSweep(env, deps);

    expect(result).toMatchObject({ due: 1, processed: 1, failed: 0 });
    expect(deps.openTenant).toHaveBeenCalledExactlyOnceWith(env, 'org_acme');
    const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    expect(row).toMatchObject({ status: 'active', warmupDay: 14, warmupInboxRate: 0.9, rampCurrent: 10 });
    // Still ramping from 10 to 30: back tomorrow, after the next 03:15 run is due.
    expect(await dueAt('org_acme')).toBe(TOMORROW);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0]).toMatchObject({ workspaceId: 'org_acme', entityType: 'reach_mailbox', action: 'updated', entityId: 'rmbx_1' });
  });

  it('drops the due row once nothing is left to track', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 30 });
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);

    await runWarmupSweep(env, sweepDeps());
    expect(await dueAt('org_acme')).toBeNull();
  });

  it('does not open workspaces that are not due, and never lists other kinds', async () => {
    await markWorkspaceDue(d1, 'reach_warmup', 'org_later', CRON.getTime() + 3_600_000);
    await markWorkspaceDue(d1, 'reach_send', 'org_send', CRON.getTime() - 1000);
    const deps = sweepDeps();

    const result = await runWarmupSweep(env, deps);
    expect(result.due).toBe(0);
    expect(deps.openTenant).not.toHaveBeenCalled();
    expect(deps.readAccess).not.toHaveBeenCalled();
  });

  it('seeds nothing on the first run (WeldReach has no earlier mailboxes) and only once', async () => {
    const deps = sweepDeps();
    await runWarmupSweep(env, deps);
    expect(await env.WORKSPACE_CACHE.get(WARMUP_INDEX_SEED_KEY)).not.toBeNull();
    expect(await d1.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n')).toBe(0);
  });

  it('skips a suspended workspace without opening its tenant, and checks again tomorrow', async () => {
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const deps = sweepDeps({ readAccess: vi.fn(async () => approvedAccess({ status: 'suspended' })) });

    await runWarmupSweep(env, deps);

    expect(deps.openTenant).not.toHaveBeenCalled();
    expect(await dueAt('org_acme')).toBe(TOMORROW);
  });

  it('forgets a workspace that lost access for good', async () => {
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const deps = sweepDeps({ readAccess: vi.fn(async () => approvedAccess({ status: 'revoked' })) });

    await runWarmupSweep(env, deps);
    expect(deps.openTenant).not.toHaveBeenCalled();
    expect(await dueAt('org_acme')).toBeNull();
  });

  it('retries a workspace whose tenant could not be opened, later, without failing the sweep', async () => {
    await markWorkspaceDue(d1, 'reach_warmup', 'org_a', CRON.getTime() - 2000);
    await markWorkspaceDue(d1, 'reach_warmup', 'org_b', CRON.getTime() - 1000);
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 30 });
    const openTenant = vi.fn(async (_env: Env, org: string) => {
      if (org === 'org_a') throw new Error('neon down');
      return db;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runWarmupSweep(env, sweepDeps({ openTenant }));

    expect(result).toMatchObject({ due: 2, processed: 1, failed: 1 });
    expect(await dueAt('org_a')).toBe(CRON.getTime() + 6 * 3_600_000);
    expect(await dueAt('org_b')).toBeNull();
    error.mockRestore();
  });

  it('visits at most MAX_WORKSPACES_PER_RUN workspaces per run; the rest stay due', async () => {
    for (let i = 0; i < MAX_WORKSPACES_PER_RUN + 5; i++) {
      await markWorkspaceDue(d1, 'reach_warmup', `org_${String(i).padStart(3, '0')}`, CRON.getTime() - 100_000 + i);
    }
    const deps = sweepDeps();
    // Nothing to track, so each visit just drops its row.
    const result = await runWarmupSweep(env, deps);

    expect(result.processed).toBe(MAX_WORKSPACES_PER_RUN);
    expect(await d1.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n')).toBe(5);
  });

  it('still follows the pool without a Mailpool key (only mailboxes still provisioning wait for it)', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_1', status: 'warming', rampDay: 9, stats: poolStats({ inboxRate3d: 0.9 }) });
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runWarmupSweep({ ...env, MAILPOOL_API_KEY: undefined } as Env, {
      now: CRON,
      master,
      openTenant: vi.fn(async () => db),
      readAccess: vi.fn(async () => approvedAccess()),
    });

    expect(result).toMatchObject({ due: 1, processed: 1, failed: 0 });
    const [row] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, 'rmbx_1'));
    expect(row).toMatchObject({ status: 'warming', warmupDay: 9 });
    expect(await dueAt('org_acme')).toBe(TOMORROW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAILPOOL_API_KEY is not set'));
    warn.mockRestore();
  });

  it('files a mailbox that finishes provisioning in the pool under the workspace the access row names, and reports a failed login as a suspension', async () => {
    await seedMailbox(db, { id: 'rmbx_new', domainId: 'rdom_1', status: 'provisioning', mailpoolMailboxId: '341', email: 'jane@getacme.com' });
    await seedMailbox(db, { id: 'rmbx_bad', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 30 });
    await seedPoolMailbox(master, { tenantMailboxId: 'rmbx_bad', status: 'error', pausedReason: 'login_failed', lastLoginError: 'bad' });
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const deps = sweepDeps({ readAccess: vi.fn(async () => approvedAccess({ workspaceId: 'ws_other' })) });
    deps.mailpool.getMailbox.mockResolvedValue(mailpoolMailbox({ email: 'jane@getacme.com', firstName: 'Jane', lastName: 'Doe', type: 'google' }, { id: '341' }));

    await runWarmupSweep(env, deps);

    const [pool] = await master.select().from(masterSchema.reachWarmupMailboxes).where(eq(masterSchema.reachWarmupMailboxes.tenantMailboxId, 'rmbx_new'));
    expect(pool).toMatchObject({ workspaceId: 'ws_other', clerkOrgId: 'org_acme', status: 'waiting' });
    const events = published.mock.calls.map((c) => c[0] as { entityId: string; action: string; entityType: string });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: 'reach_mailbox', entityId: 'rmbx_new', action: 'updated' }),
        expect.objectContaining({ entityType: 'reach_mailbox', entityId: 'rmbx_bad', action: 'suspended' }),
      ]),
    );
  });

  it('forgets a workspace whose access row has no workspace (nothing to file pool rows under)', async () => {
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const deps = sweepDeps({ readAccess: vi.fn(async () => approvedAccess({ workspaceId: null })) });

    await runWarmupSweep(env, deps);
    expect(deps.openTenant).not.toHaveBeenCalled();
    expect(await dueAt('org_acme')).toBeNull();
  });

  it('retries a workspace whose pool could not be read, later', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming' });
    await markWorkspaceDue(d1, 'reach_warmup', 'org_acme', CRON.getTime() - 1000);
    const brokenMaster = new Proxy(master, {
      get(target, prop, receiver) {
        if (prop === 'select') return () => { throw new Error('master down'); };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runWarmupSweep(env, { ...sweepDeps(), master: brokenMaster });

    expect(result).toMatchObject({ due: 1, processed: 0, failed: 1 });
    expect(await dueAt('org_acme')).toBe(CRON.getTime() + 6 * 3_600_000);
    error.mockRestore();
  });
});
