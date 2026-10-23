/**
 * Which workspaces the hourly mail repair picks up, on a real master schema
 * (PGlite): live, recent, provisioned at least an hour ago (so the
 * provisioning workflow is done setting up mail) and without a routed mail
 * domain. Cloudflare and the mail setup itself are faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaces } from '@weldsuite/db/schema/master';
import { createMasterTestDb, type MasterTestDb } from '@weldsuite/neon-provisioning/test/master-db';
import type { Env } from '../index';
import type { MasterDatabase } from '../db';

const state = vi.hoisted(() => ({ db: null as unknown, provisioned: new Set<string>() }));

vi.mock('../db', () => ({
  getMasterDb: () => state.db,
  getTenantDbForWorkspace: vi.fn(async () => ({})),
}));
vi.mock('./mail-provisioning', () => ({
  listProvisionedMailDomains: vi.fn(async () => state.provisioned),
  workspaceMailDomain: (_env: unknown, slug: string) => `${slug}.mail.test`,
}));
vi.mock('./workspace-mail', () => ({
  ensureWorkspaceMail: vi.fn(async (_env: unknown, args: { slug: string }) => ({ domain: `${args.slug}.mail.test` })),
}));

import { ensureWorkspaceMail } from './workspace-mail';
import { repairWorkspaceMailDomains } from './mail-repair-sweep';

vi.setConfig({ hookTimeout: 180_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let master: MasterTestDb;
let masterDb: MasterDatabase;

beforeAll(async () => {
  master = await createMasterTestDb();
  masterDb = master.db as unknown as MasterDatabase;
  state.db = masterDb;
});

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  await master.reset();
  state.provisioned = new Set();
  vi.mocked(ensureWorkspaceMail).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

async function seed(slug: string, provisionedAgo: number | null): Promise<void> {
  await masterDb.insert(workspaces).values({
    id: `ws_${slug}`,
    clerkOrgId: `org_${slug}`,
    name: slug,
    slug,
    databaseProvisionedAt: provisionedAgo === null ? null : new Date(Date.now() - provisionedAgo),
    provisioningStatus: provisionedAgo === null ? 'provisioning' : 'ready',
  });
}

const repairedSlugs = () => vi.mocked(ensureWorkspaceMail).mock.calls.map(([, args]) => args.slug);

describe('repairWorkspaceMailDomains', () => {
  it('repairs a settled workspace without a routed domain', async () => {
    await seed('settled', 2 * HOUR);
    await seed('routed', 2 * HOUR);
    state.provisioned = new Set(['routed.mail.test']);

    await repairWorkspaceMailDomains({} as Env);

    expect(repairedSlugs()).toEqual(['settled']);
  });

  it('leaves a workspace whose provisioning workflow may still be setting up mail', async () => {
    await seed('just-ready', 5 * MINUTE);
    await seed('still-provisioning', null);

    await repairWorkspaceMailDomains({} as Env);

    expect(repairedSlugs()).toEqual([]);
  });
});
