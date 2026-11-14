/**
 * Settlement of WeldPanel usage against the credit wallet (ADR PANEL-007), on a
 * real master schema (pglite): the totals only grow, each overage block is
 * charged once whatever the retries, an empty wallet blocks recordings at once
 * and events past the 10% grace, a top-up lifts the block, the quota state
 * reaches KV, and each usage email goes out once per threshold per month.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { grantCredits } from '@weldsuite/credits';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { quotaKvKey } from '@weldsuite/panel-domain/registry';
import { WELDPANEL_PRICING_KEY } from '@weldsuite/panel-domain/pricing';
import { resetPanelPricingMemo } from './pricing';
import { settleUsage, usageRow, type SettlementDeps } from './usage-settlement';
import type { UsageNotice } from './usage-notices';

const { plans, workspaces, workspaceCredits, creditTransactions, systemSettings, panelUsageMonthly } = masterSchema;

const MONTH = '2026-11';
const NOW = new Date('2026-11-14T10:00:00.000Z');

let master: AnyMasterDatabase;
let kv: ReturnType<typeof memoryKv>;
let notices: UsageNotice[];
let counter = 0;

function memoryKv(entries = new Map<string, string>()) {
  return {
    entries,
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void entries.set(key, value)),
    delete: vi.fn(async (key: string) => void entries.delete(key)),
  };
}

/** A fresh workspace on `plan`, its wallet holding `credits`. */
async function workspace(plan: 'free' | 'business' | 'scale' | null, credits: number): Promise<string> {
  counter += 1;
  const id = `ws_settle_${counter}`;
  await master.insert(workspaces).values({ id, clerkOrgId: `org_settle_${counter}`, name: `Acme ${counter}`, slug: `acme-${counter}`, planId: plan ? `plan_${plan}` : null });
  if (credits > 0) await grantCredits(master, { workspaceId: id, amount: credits, type: 'monthly_allocation', description: 'test' });
  return id;
}

async function balance(workspaceId: string): Promise<number> {
  const [row] = await master.select({ balance: workspaceCredits.currentBalance }).from(workspaceCredits).where(eq(workspaceCredits.workspaceId, workspaceId));
  return row?.balance ?? 0;
}

async function charges(workspaceId: string) {
  const rows = await master.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, workspaceId));
  return rows.filter((row) => row.type === 'consumption');
}

function deps(overrides: Partial<SettlementDeps> = {}): SettlementDeps {
  return { masterDb: master, kv: kv as unknown as SettlementDeps['kv'], now: NOW, ...overrides };
}

const settle = (workspaceId: string, events: number, recordings = 0, over: Partial<SettlementDeps> = {}, month = MONTH) =>
  settleUsage(deps(over), { workspaceId, month, events, recordings });

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  await master.insert(plans).values([
    { id: 'plan_free', name: 'Free', slug: 'free', features: {} },
    { id: 'plan_business', name: 'Business', slug: 'business', features: {} },
    { id: 'plan_scale', name: 'Scale', slug: 'scale', features: { panelEventsPerMonth: 100_000 } },
  ]);
}, 120_000);

beforeEach(() => {
  kv = memoryKv();
  notices = [];
  resetPanelPricingMemo();
});

describe('inside the allowance', () => {
  it('stores the totals, charges nothing and leaves the collector unblocked', async () => {
    const ws = await workspace('free', 500);
    const result = await settle(ws, 50_000, 500);

    expect(result?.quota).toBe('ok');
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ events: 50_000, recordings: 500, eventBlocksCharged: 0, recordingBlocksCharged: 0 });
    expect(await charges(ws)).toHaveLength(0);
    expect(await balance(ws)).toBe(500);
    expect(kv.entries.has(quotaKvKey(ws))).toBe(false);
  });

  it('answers null and stores nothing for a workspace that does not exist', async () => {
    expect(await settle('ws_nobody', 10)).toBeNull();
    expect(await usageRow(master, 'ws_nobody', MONTH)).toBeUndefined();
  });

  it('takes a workspace without a plan as Free', async () => {
    const ws = await workspace(null, 100);
    const result = await settle(ws, 50_001);
    expect(result?.workspace.limits.events).toBe(50_000);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1 });
  });
});

describe('overage blocks', () => {
  it('charges the first block when the allowance is passed by one event, at the pricing rate', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 50_001);

    expect(await balance(ws)).toBe(90); // placeholder: 10 credits per 10,000 events
    const [charge] = await charges(ws);
    expect(charge).toMatchObject({ amount: -10, serviceType: 'panel_events', idempotencyKey: `weldpanel:${ws}:${MONTH}:events:1` });
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1, eventCreditsCharged: 10 });
  });

  it('charges every block reached, events and recordings each at their own rate', async () => {
    const ws = await workspace('free', 1_000);
    const result = await settle(ws, 75_000, 701); // 3 event blocks (60k, 70k, 80k boundaries), 3 recording blocks

    expect(result?.quota).toBe('ok');
    expect((await charges(ws)).map((c) => c.idempotencyKey).sort()).toEqual(
      [1, 2, 3].flatMap((n) => [`weldpanel:${ws}:${MONTH}:events:${n}`, `weldpanel:${ws}:${MONTH}:recordings:${n}`]).sort(),
    );
    expect(await balance(ws)).toBe(1_000 - 3 * 10 - 3 * 20);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 3, recordingBlocksCharged: 3, eventCreditsCharged: 30, recordingCreditsCharged: 60 });
  });

  it('charges a block once however often the same totals arrive, and when more of the block fills', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 50_001);
    await settle(ws, 50_001);
    await settle(ws, 55_000);
    await settle(ws, 60_000);

    expect(await charges(ws)).toHaveLength(1);
    expect(await balance(ws)).toBe(90);
  });

  it('does not charge twice when the row fell behind the ledger (a crash between the charge and the row)', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 50_001);
    await master.update(panelUsageMonthly).set({ eventBlocksCharged: 0, eventCreditsCharged: 0 }).where(eq(panelUsageMonthly.workspaceId, ws));

    await settle(ws, 50_001);

    expect(await charges(ws)).toHaveLength(1);
    expect(await balance(ws)).toBe(90);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1, eventCreditsCharged: 10 });
  });

  it('charges once when two settlements run at the same time', async () => {
    const ws = await workspace('free', 100);
    await Promise.all([settle(ws, 50_001), settle(ws, 50_001), settle(ws, 50_001)]);

    expect(await charges(ws)).toHaveLength(1);
    expect(await balance(ws)).toBe(90);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1, eventCreditsCharged: 10 });
  });

  it('keeps the totals when an older, lower report arrives later', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 51_000, 40);
    await settle(ws, 49_000, 10);

    expect(await usageRow(master, ws, MONTH)).toMatchObject({ events: 51_000, recordings: 40 });
  });

  it('uses the plan\'s allowance, including a feature override', async () => {
    const business = await workspace('business', 100);
    await settle(business, 1_000_000);
    expect(await charges(business)).toHaveLength(0);
    await settle(business, 1_000_001);
    expect(await charges(business)).toHaveLength(1);

    const scale = await workspace('scale', 100); // Scale is overridden to 100,000 events in this test
    await settle(scale, 100_000);
    expect(await charges(scale)).toHaveLength(0);
    await settle(scale, 100_001);
    expect(await charges(scale)).toHaveLength(1);
  });

  it('reads the price from the weldpanel.pricing row, and falls back to the defaults without one', async () => {
    await master.insert(systemSettings).values({ id: 'set_panel_price', key: WELDPANEL_PRICING_KEY, category: 'billing', value: { eventsCreditsPer10k: 7, recordingsCreditsPer100: 13 } });
    resetPanelPricingMemo();
    const ws = await workspace('free', 100);
    await settle(ws, 50_001, 501);
    expect(await balance(ws)).toBe(100 - 7 - 13);

    await master.delete(systemSettings).where(eq(systemSettings.key, WELDPANEL_PRICING_KEY));
    resetPanelPricingMemo();
    kv = memoryKv();
    const other = await workspace('free', 100);
    await settle(other, 50_001);
    expect(await balance(other)).toBe(90);
  });
});

describe('when the wallet cannot pay', () => {
  it('blocks recordings at once, and keeps events inside the 10% grace counted from the allowance', async () => {
    const ws = await workspace('free', 0);
    const result = await settle(ws, 55_000); // over the allowance, exactly at allowance + 10%

    expect(result?.quota).toBe('replay_blocked');
    expect(kv.entries.get(quotaKvKey(ws))).toBe('replay_blocked');
    expect(await charges(ws)).toHaveLength(0);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 0 });
  });

  it('drops events once they pass the allowance plus 10%', async () => {
    const ws = await workspace('free', 0);
    const result = await settle(ws, 55_001);

    expect(result?.quota).toBe('events_blocked');
    expect(kv.entries.get(quotaKvKey(ws))).toBe('events_blocked');
  });

  it('blocks recordings alone when only a recording block is unpaid', async () => {
    const ws = await workspace('free', 0);
    const result = await settle(ws, 1_000, 501);

    expect(result?.quota).toBe('replay_blocked');
    expect(kv.entries.get(quotaKvKey(ws))).toBe('replay_blocked');
  });

  it('pays the blocks it can and blocks on the first it cannot', async () => {
    const ws = await workspace('free', 15); // one event block (10) and not the second
    const result = await settle(ws, 70_001); // 3 blocks needed, 40% over: past the grace

    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1, eventCreditsCharged: 10 });
    expect(await balance(ws)).toBe(5);
    expect(result?.quota).toBe('events_blocked');
  });

  it('lifts the block by itself after a top-up: the same totals charge the unpaid blocks and clear the state', async () => {
    const ws = await workspace('free', 0);
    await settle(ws, 70_001, 501);
    expect(kv.entries.get(quotaKvKey(ws))).toBe('events_blocked');

    await grantCredits(master, { workspaceId: ws, amount: 500, type: 'purchase', description: 'top-up' });
    const result = await settle(ws, 70_001, 501);

    expect(result?.quota).toBe('ok');
    expect(kv.entries.has(quotaKvKey(ws))).toBe(false);
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 3, recordingBlocksCharged: 1 });
    expect(await balance(ws)).toBe(500 - 3 * 10 - 1 * 20);
  });

  it('starts clean in a new month: zero totals settle to ok and clear the old state', async () => {
    const ws = await workspace('free', 0);
    await settle(ws, 70_001);
    expect(kv.entries.get(quotaKvKey(ws))).toBe('events_blocked');

    const december = new Date('2026-12-01T00:05:00.000Z');
    const result = await settle(ws, 0, 0, { now: december }, '2026-12');
    expect(result?.quota).toBe('ok');
    expect(kv.entries.has(quotaKvKey(ws))).toBe(false);
  });

  it('charges a late report for a finished month but leaves the collector\'s state alone', async () => {
    const ws = await workspace('free', 100);
    kv.entries.set(quotaKvKey(ws), 'replay_blocked');
    await settle(ws, 50_001, 0, {}, '2026-10');

    expect(await charges(ws)).toHaveLength(1);
    expect(kv.entries.get(quotaKvKey(ws))).toBe('replay_blocked');
  });
});

describe('usage emails', () => {
  const collect = { notify: async (notice: UsageNotice) => void notices.push(notice) };

  it('sends nothing below 80%', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 39_999, 399, collect);
    expect(notices).toEqual([]);
  });

  it('sends the 80% notice once, however often the totals are settled', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 40_000, 0, collect);
    await settle(ws, 41_000, 0, collect);
    await settle(ws, 49_000, 0, collect);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      workspaceId: ws,
      kind: 'near',
      month: MONTH,
      events: { used: 40_000, allowance: 50_000 },
      recordings: { used: 0, allowance: 500 },
    });
    expect(notices[0]!.workspaceName).toMatch(/^Acme/);
    expect(notices[0]!.clerkOrgId).toMatch(/^org_settle_/);
  });

  it('reaches 80% through recordings as well', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 10, 400, collect);
    expect(notices.map((n) => n.kind)).toEqual(['near']);
  });

  it('sends 100% after 80%, once each', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 41_000, 0, collect);
    await settle(ws, 50_000, 0, collect);
    await settle(ws, 50_001, 0, collect);
    await settle(ws, 50_500, 0, collect);

    expect(notices.map((n) => n.kind)).toEqual(['near', 'full']);
  });

  it('sends one mail for the highest threshold when several are crossed at once, and none for the lower ones later', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 52_000, 0, collect);
    await settle(ws, 53_000, 0, collect);

    expect(notices.map((n) => n.kind)).toEqual(['full']);
  });

  it('warns when recordings stop, and again when events are dropped', async () => {
    const ws = await workspace('free', 0);
    await settle(ws, 53_000, 0, collect); // over, wallet empty, inside the grace: recordings stop
    await settle(ws, 53_500, 0, collect);
    await settle(ws, 56_000, 0, collect); // past the grace: events dropped
    await settle(ws, 57_000, 0, collect);

    expect(notices.map((n) => n.kind)).toEqual(['replay_blocked', 'events_blocked']);
  });

  it('warns about dropped events at once when the wallet is empty and the jump is large', async () => {
    const ws = await workspace('free', 0);
    await settle(ws, 90_000, 0, collect);
    expect(notices.map((n) => n.kind)).toEqual(['events_blocked']);
  });

  it('sends the same threshold again in a new month', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 41_000, 0, collect);
    await settle(ws, 41_000, 0, { ...collect, now: new Date('2026-12-02T00:00:00.000Z') }, '2026-12');

    expect(notices.map((n) => `${n.month}:${n.kind}`)).toEqual(['2026-11:near', '2026-12:near']);
  });

  it('sends nothing for a late report about a finished month', async () => {
    const ws = await workspace('free', 100);
    await settle(ws, 45_000, 0, collect, '2026-10');
    expect(notices).toEqual([]);
  });

  it('sends one mail when settlements run at the same time', async () => {
    const ws = await workspace('free', 100);
    await Promise.all([settle(ws, 41_000, 0, collect), settle(ws, 41_000, 0, collect), settle(ws, 41_000, 0, collect)]);
    expect(notices).toHaveLength(1);
  });

  it('keeps the settlement when the mail fails', async () => {
    const ws = await workspace('free', 100);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await settle(ws, 51_000, 0, { notify: async () => Promise.reject(new Error('mail down')) });

    expect(result?.quota).toBe('ok');
    expect(await usageRow(master, ws, MONTH)).toMatchObject({ eventBlocksCharged: 1 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
