/**
 * Alert checks: which period is judged (in the spec's timezone), the three
 * conditions, and the state machine on a real tenant schema (pglite): `fired`
 * once on ok → firing, `resolved` once on firing → ok, `error` with the
 * reason, a snoozed alert recorded but silent, a skipped check left alone.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelAlert } from '@weldsuite/db/schema';
import type { PanelQueryResult, ParsedPanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelAlertCondition } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { checkSpec, checkWindow, evaluateCondition, runAlertCheck, type AlertCheckDeps } from './alerts';
import type { PanelMessage } from './delivery';

const { panelAlertEvents, panelAlerts, panelProjects } = schema;

describe('checkWindow', () => {
  const NOW = new Date('2026-11-18T10:20:00Z'); // Wednesday

  it('hourly: the last full local hour, the hour before, the same hour on 14 days', () => {
    const w = checkWindow('hourly', 'anomaly', 'Europe/Amsterdam', NOW); // 11:20 CET
    expect(w.interval).toBe('hour');
    expect(w.target).toBe('2026-11-18T10:00');
    expect(w.previous).toBe('2026-11-18T09:00');
    expect(w.baseline).toHaveLength(14);
    expect(w.baseline[0]).toBe('2026-11-17T10:00');
    expect(w.baseline[13]).toBe('2026-11-04T10:00');
    expect(w.dateRange).toEqual({ from: '2026-11-04', to: '2026-11-18' });
    expect(checkWindow('hourly', 'threshold', 'UTC', NOW).dateRange).toEqual({ from: '2026-11-18', to: '2026-11-18' });
  });

  it('daily: yesterday in the timezone, the 28 days before for an anomaly', () => {
    const w = checkWindow('daily', 'change', 'America/New_York', new Date('2026-11-18T03:00:00Z')); // 22:00 on the 17th in New York
    expect(w.target).toBe('2026-11-16');
    expect(w.previous).toBe('2026-11-15');
    expect(w.dateRange).toEqual({ from: '2026-11-15', to: '2026-11-16' });
    const a = checkWindow('daily', 'anomaly', 'UTC', NOW);
    expect(a.baseline).toHaveLength(28);
    expect(a.dateRange).toEqual({ from: '2026-10-20', to: '2026-11-17' });
  });

  it('weekly: last Monday-to-Sunday week', () => {
    const w = checkWindow('weekly', 'threshold', 'UTC', NOW);
    expect(w.interval).toBe('week');
    expect(w.target).toBe('2026-11-09');
    expect(w.previous).toBe('2026-11-02');
    expect(w.dateRange).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });
});

describe('checkSpec', () => {
  it('runs one plain series over the window: no breakdown, formulas or compare', () => {
    const spec = checkSpec(
      {
        kind: 'trends',
        projectId: 'pnp_a',
        dateRange: { preset: '30d' },
        timezone: 'UTC',
        filters: [],
        interval: 'month',
        compare: true,
        series: [{ event: 'Signed up', math: 'total', filters: [] }],
        breakdown: { source: 'column', field: 'country', limit: 10 },
      } as never,
      checkWindow('daily', 'threshold', 'UTC', new Date('2026-11-18T10:00:00Z')),
    );
    expect(spec).toMatchObject({ dateRange: { from: '2026-11-17', to: '2026-11-17' }, interval: 'day', compare: false });
    expect(spec).not.toHaveProperty('breakdown');
  });
});

describe('evaluateCondition', () => {
  const window = checkWindow('daily', 'anomaly', 'UTC', new Date('2026-11-18T10:00:00Z'));
  const points = (target: number, previous?: number, baseline: number[] = []) => {
    const map = new Map<string, number>([[window.target, target]]);
    if (previous !== undefined) map.set(window.previous, previous);
    baseline.forEach((v, i) => map.set(window.baseline[i]!, v));
    return map;
  };

  it('threshold above / below', () => {
    expect(evaluateCondition({ type: 'threshold', operator: 'above', value: 100 }, points(101), window)).toEqual({ status: 'firing', value: 101, bound: 100 });
    expect(evaluateCondition({ type: 'threshold', operator: 'above', value: 100 }, points(100), window).status).toBe('ok');
    expect(evaluateCondition({ type: 'threshold', operator: 'below', value: 10 }, points(3), window).status).toBe('firing');
  });

  it('change against the period before, both ways and either way', () => {
    const up: PanelAlertCondition = { type: 'change', direction: 'increase', percent: 20 };
    expect(evaluateCondition(up, points(120, 100), window)).toEqual({ status: 'firing', value: 120, bound: 120 });
    expect(evaluateCondition(up, points(119, 100), window).status).toBe('ok');
    expect(evaluateCondition({ type: 'change', direction: 'decrease', percent: 50 }, points(40, 100), window)).toEqual({ status: 'firing', value: 40, bound: 50 });
    expect(evaluateCondition({ type: 'change', direction: 'any', percent: 50 }, points(40, 100), window).status).toBe('firing');
    expect(evaluateCondition({ type: 'change', direction: 'any', percent: 50 }, points(160, 100), window).status).toBe('firing');
    // From nothing to something is an increase of any size.
    expect(evaluateCondition(up, points(5, 0), window).status).toBe('firing');
    expect(evaluateCondition(up, points(0, 0), window).status).toBe('ok');
    expect(evaluateCondition(up, points(5), window).status).toBe('skipped');
  });

  it('anomaly: outside median ± k·MAD of the baseline, skipped with fewer than 7 points', () => {
    const baseline = [100, 102, 98, 101, 99, 103, 97, 100, 100, 101];
    expect(evaluateCondition({ type: 'anomaly', sensitivity: 'medium' }, points(160, undefined, baseline), window).status).toBe('firing');
    expect(evaluateCondition({ type: 'anomaly', sensitivity: 'medium' }, points(101, undefined, baseline), window).status).toBe('ok');
    expect(evaluateCondition({ type: 'anomaly', sensitivity: 'medium' }, points(160, undefined, baseline.slice(0, 6)), window).status).toBe('skipped');
  });

  it('skips a period the result does not have', () => {
    expect(evaluateCondition({ type: 'threshold', operator: 'above', value: 1 }, new Map(), window).status).toBe('skipped');
  });
});

describe('runAlertCheck', () => {
  let db: Database;
  const NOW = new Date('2026-11-18T10:20:00Z');
  const SPEC = { kind: 'trends', projectId: 'pnp_a', timezone: 'UTC', series: [{ event: 'Signed up', label: 'Signups' }] };

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  beforeEach(async () => {
    await db.delete(panelAlertEvents);
    await db.delete(panelAlerts);
    await db.delete(panelProjects);
    await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  });

  async function alert(overrides: Partial<typeof panelAlerts.$inferInsert> = {}): Promise<PanelAlert> {
    const [row] = await db
      .insert(panelAlerts)
      .values({
        id: 'pnal_1',
        projectId: 'pnp_a',
        name: 'Signups',
        spec: SPEC,
        condition: { type: 'threshold', operator: 'above', value: 100 },
        checkInterval: 'daily',
        channels: { emailUserIds: ['user_alice'], inApp: false, slack: false },
        ownerUserId: 'user_alice',
        ...overrides,
      })
      .returning();
    return row!;
  }

  function trends(value: number): PanelQueryResult {
    return {
      kind: 'trends',
      result: {
        range: { from: '', to: '', timezone: 'UTC', clampedToRetention: false, previousFrom: null, previousTo: null },
        interval: 'day',
        series: [{ seriesIndex: 0, label: 'Signups', breakdownValue: null, total: value, points: [{ bucket: '2026-11-17', value }], previous: null }],
      },
    } as PanelQueryResult;
  }

  function deps(value: number | Error) {
    const delivered: PanelMessage[] = [];
    const published: string[] = [];
    const ran: ParsedPanelQuerySpec[] = [];
    const d: AlertCheckDeps = {
      db,
      now: NOW,
      run: async (spec) => {
        ran.push(spec);
        if (value instanceof Error) throw value;
        return trends(value);
      },
      deliver: vi.fn(async (_target, message: PanelMessage) => {
        delivered.push(message);
        return [{ channel: 'email' as const, ok: true, recipients: 1, error: null }];
      }),
      publish: async (_a, action) => {
        published.push(action);
      },
    };
    return { d, delivered, published, ran };
  }

  const events = () => db.select().from(panelAlertEvents);

  it('fires once on the move into firing, and messages the channels', async () => {
    const a = await alert();
    const first = deps(150);
    const result = await runAlertCheck(first.d, a);
    expect(result.outcome).toBe('fired');
    expect(result.alert).toMatchObject({ state: 'firing', lastValue: 150, lastError: null });
    expect(result.alert.lastFiredAt?.toISOString()).toBe(NOW.toISOString());
    expect(first.published).toEqual(['fired']);
    expect(first.delivered).toHaveLength(1);
    expect(first.delivered[0]).toMatchObject({ kind: 'alert', entityId: 'pnal_1', alert: { event: 'fired', metric: 'Signups', value: 150, bound: 100, period: '2026-11-17', projectName: 'Shop' } });
    expect(first.ran[0]).toMatchObject({ dateRange: { from: '2026-11-17', to: '2026-11-17' }, interval: 'day' });
    expect(await events()).toMatchObject([{ kind: 'fired', value: 150, bound: 100 }]);

    // Still firing: nothing new.
    const again = deps(170);
    expect((await runAlertCheck(again.d, result.alert)).outcome).toBe('firing');
    expect(again.published).toEqual([]);
    expect(again.delivered).toEqual([]);
    expect(await events()).toHaveLength(1);
  });

  it('resolves once on the move back, and an ok alert stays quiet', async () => {
    const a = await alert({ state: 'firing', lastFiredAt: new Date('2026-11-17T00:15:00Z') });
    const back = deps(20);
    const result = await runAlertCheck(back.d, a);
    expect(result.outcome).toBe('resolved');
    expect(result.alert.state).toBe('ok');
    expect(back.published).toEqual(['resolved']);
    expect(back.delivered[0]).toMatchObject({ alert: { event: 'resolved', value: 20 } });

    const quiet = deps(30);
    expect((await runAlertCheck(quiet.d, result.alert)).outcome).toBe('ok');
    expect(quiet.delivered).toEqual([]);
  });

  it('records the transition but sends nothing while snoozed', async () => {
    const a = await alert({ snoozedUntil: new Date('2026-11-19T00:00:00Z') });
    const snoozed = deps(500);
    const result = await runAlertCheck(snoozed.d, a);
    expect(result.outcome).toBe('fired');
    expect(snoozed.published).toEqual(['fired']);
    expect(snoozed.delivered).toEqual([]);
    expect(await events()).toHaveLength(1);
  });

  it('goes to error with the reason, once, and resolves from error when it had fired', async () => {
    const a = await alert({ state: 'firing', lastFiredAt: new Date('2026-11-17T00:15:00Z') });
    await db.insert(panelAlertEvents).values({ id: 'pnae_0', alertId: 'pnal_1', projectId: 'pnp_a', kind: 'fired', value: 150, bound: 100, createdAt: new Date('2026-11-17T00:15:00Z') });
    const broken = deps(new Error('R2 SQL API error 500'));
    const failed = await runAlertCheck(broken.d, a);
    expect(failed.outcome).toBe('error');
    expect(failed.alert).toMatchObject({ state: 'error', lastError: 'R2 SQL API error 500' });
    await runAlertCheck(broken.d, failed.alert);
    expect((await events()).filter((e) => e.kind === 'error')).toHaveLength(1);

    const fixed = deps(10);
    const result = await runAlertCheck(fixed.d, (await db.select().from(panelAlerts).where(eq(panelAlerts.id, 'pnal_1')))[0]!);
    expect(result.outcome).toBe('resolved');
    expect(fixed.published).toEqual(['resolved']);
  });

  it('errors when its report is gone, and skips an anomaly without history', async () => {
    const orphan = await alert({ spec: null, reportId: 'pnr_gone' });
    const gone = await runAlertCheck(deps(1).d, orphan);
    expect(gone.alert).toMatchObject({ state: 'error', lastError: 'The report this alert watches was deleted' });

    await db.delete(panelAlerts);
    const anomaly = await alert({ condition: { type: 'anomaly', sensitivity: 'high' } });
    const skipped = await runAlertCheck(deps(5).d, anomaly);
    expect(skipped.outcome).toBe('skipped');
    expect(skipped.alert).toMatchObject({ state: 'pending', lastValue: 5 });
  });
});
