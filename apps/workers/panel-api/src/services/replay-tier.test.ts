/**
 * The replay tier in the collector's project records: written from the
 * workspace's plan when a project syncs (`90d` on Scale and Enterprise, left
 * out for the default `30d`), and brought in step when the plan changes.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PanelProject } from '@weldsuite/db/schema';
import { parseProjectRecord, projectKvKey } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { applyReplayTier, syncProjectRegistry, tierKvKey } from './project-registry';

const { plans, workspaces, panelProjectRegistry } = masterSchema;

let master: AnyMasterDatabase;
const store = new Map<string, string>();
const kv = {
  get: async (key: string) => store.get(key) ?? null,
  put: async (key: string, value: string) => void store.set(key, value),
  delete: async (key: string) => void store.delete(key),
} as unknown as Pick<KVNamespace, 'get' | 'put' | 'delete'>;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  await master.insert(plans).values([
    { id: 'plan_t_free', name: 'Free', slug: 'free', features: {} },
    { id: 'plan_t_scale', name: 'Scale', slug: 'scale', features: {} },
  ]);
  await master.insert(workspaces).values([
    { id: 'ws_tier_free', clerkOrgId: 'org_tier_free', name: 'Free', slug: 'tier-free', planId: 'plan_t_free' },
    { id: 'ws_tier_scale', clerkOrgId: 'org_tier_scale', name: 'Scale', slug: 'tier-scale', planId: 'plan_t_scale' },
    { id: 'ws_tier_none', clerkOrgId: 'org_tier_none', name: 'None', slug: 'tier-none' },
  ]);
}, 120_000);

beforeEach(() => store.clear());

let counter = 0;
function project(overrides: Partial<PanelProject> = {}): PanelProject {
  counter += 1;
  const now = new Date();
  return {
    id: `pnp_tier_${counter}`,
    name: 'Site',
    kind: 'website',
    status: 'active',
    token: `wpk_${String(counter).padStart(32, '0')}`,
    allowedDomains: [],
    settings: DEFAULT_PANEL_SETTINGS,
    createdByUserId: 'user_alice',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

const record = (token: string) => parseProjectRecord(store.get(projectKvKey(token)) ?? null);

describe('syncProjectRegistry', () => {
  it('writes replayTier 90d for a workspace on a 90-day plan', async () => {
    const p = project();
    await syncProjectRegistry({ masterDb: master, kv, workspaceId: 'ws_tier_scale' }, p);
    expect(record(p.token)).toMatchObject({ workspaceId: 'ws_tier_scale', replayTier: '90d' });
  });

  it('leaves it out for the default tier, so Free and plan-less workspaces keep the record they always had', async () => {
    for (const workspaceId of ['ws_tier_free', 'ws_tier_none', 'ws_unknown']) {
      const p = project();
      await syncProjectRegistry({ masterDb: master, kv, workspaceId }, p);
      expect(record(p.token)).not.toHaveProperty('replayTier');
    }
  });
});

describe('applyReplayTier', () => {
  async function registered(workspaceId: string) {
    const p = project();
    await syncProjectRegistry({ masterDb: master, kv, workspaceId }, p);
    return p;
  }

  it('moves the workspace\'s project records to the new tier and remembers it', async () => {
    const a = await registered('ws_tier_free');
    const b = await registered('ws_tier_free');
    const other = await registered('ws_tier_none');

    await applyReplayTier({ masterDb: master, kv }, 'ws_tier_free', '90d');

    expect(record(a.token)?.replayTier).toBe('90d');
    expect(record(b.token)?.replayTier).toBe('90d');
    expect(record(other.token)).not.toHaveProperty('replayTier');
    expect(store.get(tierKvKey('ws_tier_free'))).toBe('90d');

    // A downgrade takes it away again.
    await applyReplayTier({ masterDb: master, kv }, 'ws_tier_free', '30d');
    expect(record(a.token)).not.toHaveProperty('replayTier');
    expect(store.get(tierKvKey('ws_tier_free'))).toBe('30d');
  });

  it('does nothing when the marker already names the tier', async () => {
    const a = await registered('ws_tier_free');
    store.set(tierKvKey('ws_tier_free'), '90d');
    await applyReplayTier({ masterDb: master, kv }, 'ws_tier_free', '90d');
    expect(record(a.token)).not.toHaveProperty('replayTier');
  });

  it('skips deleted projects and records that are gone from KV', async () => {
    const live = await registered('ws_tier_free');
    const gone = await registered('ws_tier_free');
    await master.update(panelProjectRegistry).set({ deletedAt: new Date() }).where(eq(panelProjectRegistry.projectId, gone.id));
    const missing = await registered('ws_tier_free');
    store.delete(projectKvKey(missing.token));

    await applyReplayTier({ masterDb: master, kv }, 'ws_tier_free', '90d');

    expect(record(live.token)?.replayTier).toBe('90d');
    expect(record(gone.token)).not.toHaveProperty('replayTier');
    expect(store.has(projectKvKey(missing.token))).toBe(false);
  });
});
