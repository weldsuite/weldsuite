import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as masterSchema from '@weldsuite/db/schema/master';
import {
  BANK_FEED_RETRY_MS,
  masterDueStore,
  runBankFeedDueSweep,
  type BankFeedDueRow,
  type BankFeedDueStore,
  type BankFeedMasterDb,
} from './bank-feed-due';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const HOUR = 3_600_000;

function row(overrides: Partial<BankFeedDueRow> = {}): BankFeedDueRow {
  return {
    id: 'bfi_1',
    provider: 'plaid',
    providerConnectionId: 'item_1',
    clerkOrgId: 'org_1',
    connectionId: 'bkc_1',
    syncIntervalHours: 24,
    ...overrides,
  };
}

function fakeStore(rows: BankFeedDueRow[]) {
  const scheduled: Array<{ ids: string[]; nextSyncAt: Date; lastTriggeredAt: Date; lastError: string | null }> = [];
  const deactivated: Array<{ ids: string[]; reason: string }> = [];
  const store: BankFeedDueStore = {
    listDue: async () => rows,
    schedule: async (ids, patch) => void scheduled.push({ ids, ...patch }),
    deactivate: async (ids, reason) => void deactivated.push({ ids, reason }),
  };
  return { store, scheduled, deactivated };
}

function books(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; orgId: string | null }> = [];
  const BOOKS_INTERNAL = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, orgId: new Headers(init.headers).get('X-Workspace-Id') });
      return respond(url, init);
    },
  } as unknown as Fetcher;
  return { BOOKS_INTERNAL, calls };
}

const ok = (data: Record<string, unknown> = {}) => new Response(JSON.stringify({ data: { connectionId: 'bkc_1', status: 'active', ...data } }), { status: 200 });

describe('runBankFeedDueSweep', () => {
  it('syncs each due connection in its workspace and schedules the next run', async () => {
    const { store, scheduled } = fakeStore([row(), row({ id: 'bfi_2', connectionId: 'bkc_2', clerkOrgId: 'org_2', syncIntervalHours: 6 })]);
    const env = books(() => ok());

    const result = await runBankFeedDueSweep(store, env, NOW);

    expect(result).toEqual({ due: 2, synced: 2, failed: 0, skipped: 0, deactivated: 0 });
    expect(env.calls).toEqual([
      { url: 'https://internal/internal/bank-connections/bkc_1/sync', orgId: 'org_1' },
      { url: 'https://internal/internal/bank-connections/bkc_2/sync', orgId: 'org_2' },
    ]);
    expect(scheduled).toEqual([
      { ids: ['bfi_1'], nextSyncAt: new Date(NOW.getTime() + 24 * HOUR), lastTriggeredAt: NOW, lastError: null },
      { ids: ['bfi_2'], nextSyncAt: new Date(NOW.getTime() + 6 * HOUR), lastTriggeredAt: NOW, lastError: null },
    ]);
  });

  it('syncs a connection once even when several index rows point at it (Stripe FC keeps one per account)', async () => {
    const { store, scheduled } = fakeStore([
      row({ id: 'bfi_a', providerConnectionId: 'fca_1', provider: 'stripe_fc' }),
      row({ id: 'bfi_b', providerConnectionId: 'fca_2', provider: 'stripe_fc', syncIntervalHours: 12 }),
    ]);
    const env = books(() => ok());

    const result = await runBankFeedDueSweep(store, env, NOW);

    expect(env.calls).toHaveLength(1);
    expect(result.synced).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ ids: ['bfi_a', 'bfi_b'], nextSyncAt: new Date(NOW.getTime() + 12 * HOUR) });
  });

  it('runs one connection at a time', async () => {
    const { store } = fakeStore([row(), row({ id: 'bfi_2', connectionId: 'bkc_2' })]);
    let running = 0;
    let peak = 0;
    const env = books(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return ok();
    });
    await runBankFeedDueSweep(store, env, NOW);
    expect(peak).toBe(1);
  });

  it('stops at the per-tick limit and leaves the rest due', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `bfi_${i}`, connectionId: `bkc_${i}` }));
    const { store, scheduled } = fakeStore(rows);
    const env = books(() => ok());
    await runBankFeedDueSweep(store, env, NOW, 2);
    expect(env.calls).toHaveLength(2);
    expect(scheduled).toHaveLength(2);
  });

  it('retries a failed call within the hour and records why', async () => {
    const { store, scheduled } = fakeStore([row(), row({ id: 'bfi_2', connectionId: 'bkc_2' })]);
    const env = books((url) => (url.includes('bkc_1') ? new Response('boom', { status: 500 }) : ok()));

    const result = await runBankFeedDueSweep(store, env, NOW);

    expect(result).toMatchObject({ synced: 1, failed: 1 });
    expect(scheduled[0]).toMatchObject({ ids: ['bfi_1'], nextSyncAt: new Date(NOW.getTime() + BANK_FEED_RETRY_MS), lastError: 'books-api answered 500' });
    expect(scheduled[1]?.lastError).toBeNull();
  });

  it('survives a thrown call and keeps going', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, scheduled } = fakeStore([row(), row({ id: 'bfi_2', connectionId: 'bkc_2' })]);
    const env = books((url) => {
      if (url.includes('bkc_1')) throw new Error('binding exploded');
      return ok();
    });
    const result = await runBankFeedDueSweep(store, env, NOW);
    expect(result).toMatchObject({ synced: 1, failed: 1 });
    expect(scheduled[0]).toMatchObject({ lastError: 'binding exploded', nextSyncAt: new Date(NOW.getTime() + HOUR) });
  });

  it('retries a retryable provider error soon, and waits the normal interval for one that needs the user', async () => {
    const { store, scheduled } = fakeStore([row(), row({ id: 'bfi_2', connectionId: 'bkc_2' })]);
    const env = books((url) =>
      url.includes('bkc_1')
        ? ok({ error: 'Plaid RATE_LIMIT_EXCEEDED', retryable: true })
        : ok({ error: 'Plaid INVALID_FIELD', retryable: false }),
    );

    const result = await runBankFeedDueSweep(store, env, NOW);

    expect(result.failed).toBe(2);
    expect(scheduled[0]).toMatchObject({ nextSyncAt: new Date(NOW.getTime() + BANK_FEED_RETRY_MS), lastError: 'Plaid RATE_LIMIT_EXCEEDED' });
    expect(scheduled[1]).toMatchObject({ nextSyncAt: new Date(NOW.getTime() + 24 * HOUR), lastError: 'Plaid INVALID_FIELD' });
  });

  it('counts skipped runs and deactivates connections that are gone or no longer active', async () => {
    const { store, scheduled, deactivated } = fakeStore([
      row({ id: 'bfi_busy', connectionId: 'bkc_busy' }),
      row({ id: 'bfi_gone', connectionId: 'bkc_gone' }),
      row({ id: 'bfi_off', connectionId: 'bkc_off' }),
    ]);
    const env = books((url) => {
      if (url.includes('bkc_busy')) return ok({ skipped: 'in_progress' });
      if (url.includes('bkc_gone')) return new Response('{}', { status: 404 });
      return ok({ skipped: 'not_active' });
    });

    const result = await runBankFeedDueSweep(store, env, NOW);

    expect(result).toEqual({ due: 3, synced: 0, failed: 0, skipped: 1, deactivated: 2 });
    expect(deactivated.map((d) => d.ids)).toEqual([['bfi_gone'], ['bfi_off']]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ids).toEqual(['bfi_busy']);
  });

  it('does nothing without the BOOKS_INTERNAL binding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, scheduled } = fakeStore([row()]);
    expect(await runBankFeedDueSweep(store, {}, NOW)).toEqual({ due: 0, synced: 0, failed: 0, skipped: 0, deactivated: 0 });
    expect(scheduled).toEqual([]);
  });
});

describe('masterDueStore (Postgres)', () => {
  // The master schema is not part of the tenant migrations, so create the one table the sweep reads.
  const DDL = `
    create table bank_feed_connection_index (
      id varchar(30) primary key,
      provider varchar(30) not null,
      provider_connection_id varchar(255) not null,
      clerk_org_id varchar(255) not null,
      connection_id varchar(30) not null,
      entity_id varchar(30) not null,
      is_active boolean not null default true,
      sync_interval_hours integer not null default 24,
      next_sync_at timestamptz,
      last_triggered_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `;
  let master: BankFeedMasterDb;
  let store: BankFeedDueStore;

  beforeAll(async () => {
    const client = new PGlite();
    await client.exec(DDL);
    master = drizzle(client, { schema: masterSchema }) as unknown as BankFeedMasterDb;
    store = masterDueStore(master);
    const t = masterSchema.bankFeedConnectionIndex;
    const base = { clerkOrgId: 'org_1', entityId: 'ent_1', provider: 'plaid', syncIntervalHours: 24 };
    await (master as unknown as { insert: (table: typeof t) => { values: (v: unknown[]) => Promise<unknown> } }).insert(t).values([
      { ...base, id: 'bfi_due_late', providerConnectionId: 'a', connectionId: 'bkc_a', nextSyncAt: new Date('2026-10-08T11:00:00Z') },
      { ...base, id: 'bfi_due_early', providerConnectionId: 'b', connectionId: 'bkc_b', nextSyncAt: new Date('2026-10-08T09:00:00Z') },
      { ...base, id: 'bfi_future', providerConnectionId: 'c', connectionId: 'bkc_c', nextSyncAt: new Date('2026-10-09T00:00:00Z') },
      { ...base, id: 'bfi_inactive', providerConnectionId: 'd', connectionId: 'bkc_d', nextSyncAt: new Date('2026-10-08T00:00:00Z'), isActive: false },
      { ...base, id: 'bfi_unscheduled', providerConnectionId: 'e', connectionId: 'bkc_e', nextSyncAt: null },
    ]);
  });

  it('lists active rows that are due, oldest first, never the future or inactive ones', async () => {
    const due = await store.listDue(NOW, 10);
    expect(due.map((r) => r.id)).toEqual(['bfi_due_early', 'bfi_due_late', 'bfi_unscheduled']);
    expect(due[0]).toEqual({ id: 'bfi_due_early', provider: 'plaid', providerConnectionId: 'b', clerkOrgId: 'org_1', connectionId: 'bkc_b', syncIntervalHours: 24 });
    expect(await store.listDue(NOW, 1)).toHaveLength(1);
  });

  it('moves the schedule and deactivates', async () => {
    await store.schedule(['bfi_due_early'], { nextSyncAt: new Date('2026-10-09T12:00:00Z'), lastTriggeredAt: NOW, lastError: 'x' });
    await store.deactivate(['bfi_due_late'], 'gone');
    const due = await store.listDue(NOW, 10);
    expect(due.map((r) => r.id)).toEqual(['bfi_unscheduled']);
    await store.schedule([], { nextSyncAt: NOW, lastTriggeredAt: NOW, lastError: null });
    await store.deactivate([], 'noop');
  });
});
