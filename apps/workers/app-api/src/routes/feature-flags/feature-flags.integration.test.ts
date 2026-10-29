/**
 * GET /feature-flags — the client-visible flags for the caller. Without an
 * evaluator (binding-less local dev) every flag is at its catalog default; a
 * flag the evaluator turns on comes back on. Never cached.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { featureFlagsRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('GET /feature-flags', () => {
  it('answers the catalog defaults without an evaluator', async () => {
    const t = createTestApp('/api/feature-flags', featureFlagsRoutes, { context: { tenantDb: db } });
    const res = await t.request('/api/feature-flags');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      data: {
        'upgrade-button': false,
        'weldflow-move-task': false,
        'weldhr-payroll': false,
        'weldhr-payroll-digipoort': false,
      },
    });
  });

  it('answers what the evaluator says', async () => {
    const on = new Set(['upgrade-button', 'weldhr-payroll']);
    const flags = {
      isOn: async (key: string) => on.has(key),
      getValue: async (key: string) => on.has(key),
    } as never;
    const t = createTestApp('/api/feature-flags', featureFlagsRoutes, { context: { tenantDb: db, flags } });
    const res = await t.request('/api/feature-flags');
    const body = (await res.json()) as { data: Record<string, boolean> };
    expect(body.data['upgrade-button']).toBe(true);
    expect(body.data['weldhr-payroll']).toBe(true);
    expect(body.data['weldflow-move-task']).toBe(false);
  });
});
