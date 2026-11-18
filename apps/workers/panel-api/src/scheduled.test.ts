/**
 * panel-api's cron (./scheduled.ts) on a real master and tenant schema
 * (pglite): due rows are claimed once and locked, grouped by workspace with
 * each tenant database opened once, run, and handed back with their next run;
 * a row whose object is gone or off leaves the registry; a failing item is
 * retried later without stopping the rest; out of time, rows stay due.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';

vi.mock('./services/query-run', () => ({
  queryRunDeps: () => ({}),
  runCachedQuery: async () => ({
    result: {
      kind: 'trends',
      result: {
        range: { from: '', to: '', timezone: 'UTC', clampedToRetention: false, previousFrom: null, previousTo: null },
        interval: 'day',
        series: [{ seriesIndex: 0, label: 'Signups', breakdownValue: null, total: 500, points: [{ bucket: '2026-11-15', value: 500 }], previous: null }],
      },
    },
    dataAsOf: '2026-11-16T10:00:00.000Z',
    cached: false,
  }),
}));

import { RETRY_MS, runScheduled, type WorkspaceHandle } from './scheduled';
import { upsertSchedule } from './services/schedule';
import { entityQueue } from './test-support/fakes';
import type { PanelMessage } from './services/delivery';

const { panelAlerts, panelProjects, panelSubscriptions } = schema;
const { panelScheduleRegistry } = masterSchema;

const NOW = new Date('2026-11-16T10:20:00Z');

let master: AnyMasterDatabase;
let tenant: Database;
let events: EntityEventMessage[];

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  tenant = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await master.delete(panelScheduleRegistry);
  await tenant.delete(panelAlerts);
  await tenant.delete(panelSubscriptions);
  await tenant.delete(panelProjects);
  await tenant.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  events = [];
});

async function due(objectId: string, workspaceId = 'ws_a', kind: 'alert' | 'subscription' | 'export' = 'alert', minutesAgo = 5) {
  await upsertSchedule(master, { workspaceId, kind, objectId, nextRunAt: new Date(NOW.getTime() - minutesAgo * 60_000) });
}

function opener(opened: string[], suspended = new Set<string>()) {
  return async (workspaceId: string): Promise<WorkspaceHandle> => {
    opened.push(workspaceId);
    return { db: tenant, workspaceId, clerkOrgId: `org_${workspaceId}`, suspended: suspended.has(workspaceId) };
  };
}

const env = () => ({ ENTITY_EVENTS: entityQueue(events) }) as never;
const rows = () => master.select().from(panelScheduleRegistry);

describe('claim, run, release', () => {
  it('opens each workspace once, runs every claimed row, and writes the next run', async () => {
    await due('pnal_1');
    await due('pnal_2');
    await due('pnal_3', 'ws_b');
    const opened: string[] = [];
    const ran: string[] = [];
    const next = new Date('2026-11-17T00:15:00Z');
    const summary = await runScheduled({
      env: env(),
      now: NOW,
      masterDb: master,
      openWorkspace: opener(opened),
      runItem: async (ws, row) => {
        ran.push(`${ws.workspaceId}/${row.objectId}`);
        return next;
      },
    });
    expect(summary).toMatchObject({ claimed: 3, ran: 3, failed: 0, deferred: 0 });
    expect(opened.sort()).toEqual(['ws_a', 'ws_b']);
    expect(ran.sort()).toEqual(['ws_a/pnal_1', 'ws_a/pnal_2', 'ws_b/pnal_3']);
    for (const row of await rows()) {
      expect(row.lockedUntil).toBeNull();
      expect(row.nextRunAt.toISOString()).toBe(next.toISOString());
    }
    // Nothing is due any more.
    expect((await runScheduled({ env: env(), now: NOW, masterDb: master, openWorkspace: opener([]), runItem: async () => next })).claimed).toBe(0);
  });

  it('never lets a second invocation take a row the first one holds', async () => {
    await due('pnal_1');
    let second: Awaited<ReturnType<typeof runScheduled>> | null = null;
    await runScheduled({
      env: env(),
      now: NOW,
      masterDb: master,
      openWorkspace: opener([]),
      runItem: async () => {
        // While the first run holds the row, another invocation starts.
        second = await runScheduled({ env: env(), now: NOW, masterDb: master, openWorkspace: opener([]), runItem: async () => null });
        return new Date('2026-11-17T00:00:00Z');
      },
    });
    expect(second!.claimed).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('retries a failing item later and carries on with the others', async () => {
    await due('pnal_bad');
    await due('pnal_good');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = await runScheduled({
      env: env(),
      now: NOW,
      masterDb: master,
      openWorkspace: opener([]),
      runItem: async (_ws, row) => {
        if (row.objectId === 'pnal_bad') throw new Error('boom');
        return new Date('2026-11-17T00:00:00Z');
      },
    });
    vi.restoreAllMocks();
    expect(summary).toMatchObject({ ran: 1, failed: 1 });
    const bad = (await rows()).find((r) => r.objectId === 'pnal_bad')!;
    expect(bad.nextRunAt.getTime()).toBe(NOW.getTime() + RETRY_MS);
    expect(bad.lockedUntil).toBeNull();
  });

  it('leaves rows due when out of time, and defers a suspended workspace', async () => {
    await due('pnal_1');
    await due('pnal_2', 'ws_frozen');
    const ran: string[] = [];
    const summary = await runScheduled({
      env: env(),
      now: NOW,
      masterDb: master,
      budgetMs: -1,
      openWorkspace: opener([], new Set(['ws_frozen'])),
      runItem: async (_ws, row) => {
        ran.push(row.objectId);
        return null;
      },
    });
    expect(ran).toEqual([]);
    expect(summary.deferred).toBe(2);
    const byId = new Map((await rows()).map((r) => [r.objectId, r]));
    expect(byId.get('pnal_1')!.nextRunAt.getTime()).toBe(NOW.getTime() - 5 * 60_000);
    expect(byId.get('pnal_1')!.lockedUntil).toBeNull();
    expect(byId.get('pnal_2')!.nextRunAt.getTime()).toBe(NOW.getTime() + 60 * 60_000);
  });
});

describe('the items', () => {
  async function alert(overrides: Partial<typeof panelAlerts.$inferInsert> = {}) {
    await tenant.insert(panelAlerts).values({
      id: 'pnal_1',
      projectId: 'pnp_a',
      name: 'Signups',
      spec: { kind: 'trends', projectId: 'pnp_a', timezone: 'UTC', series: [{ event: 'Signed up', label: 'Signups' }] },
      condition: { type: 'threshold', operator: 'above', value: 100 },
      checkInterval: 'daily',
      channels: { emailUserIds: [], inApp: true, slack: false },
      ownerUserId: 'user_alice',
      ...overrides,
    });
  }

  it('checks a due alert: fires, publishes `fired`, delivers, and schedules the next check', async () => {
    await alert();
    await due('pnal_1');
    const delivered: PanelMessage[] = [];
    const summary = await runScheduled({
      env: env(),
      now: NOW,
      masterDb: master,
      openWorkspace: opener([]),
      delivery: {
        senders: {
          inApp: async (_ctx, recipients, message) => {
            delivered.push(message);
            return { sent: recipients.length, failed: 0, error: null };
          },
        },
      },
    });
    expect(summary).toMatchObject({ claimed: 1, ran: 1, failed: 0 });
    expect(delivered[0]).toMatchObject({ kind: 'alert', alert: { event: 'fired', value: 500, period: '2026-11-15' } });
    expect(events.find((e) => e.action === 'fired')).toMatchObject({ entityType: 'panel_alert', entityId: 'pnal_1', metadata: { workspaceId: 'org_ws_a', userId: 'user_alice', source: 'system' } });
    const [row] = await rows();
    expect(row!.nextRunAt.toISOString()).toBe('2026-11-17T00:15:00.000Z');
  });

  it('drops the registry row of an alert that is disabled or gone, and of a missing subscription', async () => {
    await alert({ enabled: false });
    await due('pnal_1');
    await due('pnal_gone');
    await due('pnsb_gone', 'ws_a', 'subscription');
    const summary = await runScheduled({ env: env(), now: NOW, masterDb: master, openWorkspace: opener([]) });
    expect(summary.ran).toBe(3);
    expect(await rows()).toEqual([]);
  });
});
