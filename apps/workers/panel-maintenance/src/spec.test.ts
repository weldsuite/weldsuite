import { beforeAll, describe, expect, it } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { buildSpec, catalogFor, loadRetention } from './spec';

const { plans, workspaces, panelProjectRegistry } = masterSchema;

let master: AnyMasterDatabase;

function registryRow(projectId: string, workspaceId: string, deletedAt: Date | null = null) {
  return {
    projectId,
    token: `wpk_${projectId}`,
    workspaceId,
    status: 'active' as const,
    allowedDomains: [],
    settings: {} as never,
    deletedAt,
  };
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  await master.insert(plans).values([
    { id: 'plan_m_free', name: 'Free', slug: 'free', features: {} },
    { id: 'plan_m_business', name: 'Business', slug: 'business', features: {} },
    { id: 'plan_m_scale', name: 'Scale', slug: 'scale', features: {} },
  ]);
  await master.insert(workspaces).values([
    { id: 'ws_m_free', clerkOrgId: 'org_m_free', name: 'Free', slug: 'm-free', planId: 'plan_m_free' },
    { id: 'ws_m_business', clerkOrgId: 'org_m_business', name: 'Business', slug: 'm-business', planId: 'plan_m_business' },
    { id: 'ws_m_scale', clerkOrgId: 'org_m_scale', name: 'Scale', slug: 'm-scale', planId: 'plan_m_scale' },
    { id: 'ws_m_none', clerkOrgId: 'org_m_none', name: 'None', slug: 'm-none' },
  ]);
  await master.insert(panelProjectRegistry).values([
    registryRow('pnp_free_b', 'ws_m_free'),
    registryRow('pnp_free_a', 'ws_m_free'),
    registryRow('pnp_none', 'ws_m_none'),
    registryRow('pnp_business', 'ws_m_business'),
    registryRow('pnp_scale', 'ws_m_scale'),
    registryRow('pnp_gone', 'ws_m_scale', new Date()),
  ]);
}, 120_000);

describe('loadRetention', () => {
  it('groups live projects by how long their plan keeps events: 12 months on Free (and without a plan), 25 above', async () => {
    expect(await loadRetention(master)).toEqual([
      { months: 12, projectIds: ['pnp_free_a', 'pnp_free_b', 'pnp_none'] },
      { months: 25, projectIds: ['pnp_business', 'pnp_scale'] },
    ]);
  });

  it('leaves deleted projects to the longest retention', async () => {
    const groups = await loadRetention(master);
    expect(groups.flatMap((g) => g.projectIds)).not.toContain('pnp_gone');
  });
});

describe('buildSpec', () => {
  it('carries the run, the erasures without their queue times, the retention and the longest retention', () => {
    const spec = buildSpec({
      runId: 'maintenance-2026-11-15',
      now: new Date('2026-11-15T03:00:00.000Z'),
      erasures: [{ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1'], oldest: '2026-11-10T00:00:00.000Z' }],
      retention: [{ months: 12, projectIds: ['pnp_1'] }],
    });

    expect(spec).toEqual({
      runId: 'maintenance-2026-11-15',
      now: '2026-11-15T03:00:00.000Z',
      erasures: [{ workspaceId: 'ws_a', projectId: 'pnp_1', ids: ['u1'] }],
      retention: [{ months: 12, projectIds: ['pnp_1'] }],
      maxRetentionMonths: 25,
    });
  });

  it('works with nothing to erase and no projects: only the longest retention applies', () => {
    const spec = buildSpec({ runId: 'r', now: new Date('2026-11-15T03:00:00.000Z'), erasures: [], retention: [] });
    expect(spec).toMatchObject({ erasures: [], retention: [], maxRetentionMonths: 25 });
  });
});

describe('catalogFor', () => {
  it('derives the R2 Data Catalog address from the account and bucket', () => {
    expect(catalogFor({ CF_ACCOUNT_ID: 'acc123', PANEL_BASIN_BUCKET: 'weldsuite-panel-test' })).toEqual({
      uri: 'https://catalog.cloudflarestorage.com/acc123/weldsuite-panel-test',
      warehouse: 'acc123_weldsuite-panel-test',
    });
  });

  it('takes explicit overrides', () => {
    expect(catalogFor({ CF_ACCOUNT_ID: 'a', PANEL_BASIN_BUCKET: 'b', PANEL_CATALOG_URI: 'https://x', PANEL_CATALOG_WAREHOUSE: 'w' })).toEqual({ uri: 'https://x', warehouse: 'w' });
  });
});
