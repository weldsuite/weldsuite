import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import { masterBankFeedIndex } from './master-index';

// The master schema is not part of the tenant migrations pglite loads, so create the one table the index uses.
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
  create unique index bank_feed_connection_index_provider_uidx on bank_feed_connection_index (provider, provider_connection_id);
`;

let master: MasterDatabase;
const t = masterSchema.bankFeedConnectionIndex;

beforeAll(async () => {
  const client = new PGlite();
  await client.exec(DDL);
  master = drizzle(client, { schema: masterSchema }) as unknown as MasterDatabase;
});

const row = (overrides: Partial<Parameters<ReturnType<typeof masterBankFeedIndex>['upsert']>[0][number]> = {}) => ({
  provider: 'plaid',
  providerConnectionId: 'item_1',
  clerkOrgId: 'org_1',
  connectionId: 'bkc_1',
  entityId: 'ent_1',
  syncIntervalHours: 24,
  nextSyncAt: new Date('2026-10-09T00:00:00Z'),
  ...overrides,
});

describe('master bank feed index', () => {
  it('inserts one row per webhook key and updates them on a relink instead of duplicating', async () => {
    const index = masterBankFeedIndex(master);
    await index.upsert([row({ provider: 'stripe_fc', providerConnectionId: 'fca_1' }), row({ provider: 'stripe_fc', providerConnectionId: 'fca_2' })]);
    await index.setActive('bkc_1', false, 'boom');
    await index.upsert([row({ provider: 'stripe_fc', providerConnectionId: 'fca_1', connectionId: 'bkc_9', syncIntervalHours: 6 })]);

    const rows = await master.select().from(t).where(eq(t.provider, 'stripe_fc'));
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.providerConnectionId === 'fca_1');
    expect(first).toMatchObject({ connectionId: 'bkc_9', isActive: true, lastError: null, syncIntervalHours: 6, clerkOrgId: 'org_1' });
    expect(first?.nextSyncAt?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    // The key that was not re-upserted keeps its deactivated state.
    expect(rows.find((r) => r.providerConnectionId === 'fca_2')).toMatchObject({ isActive: false, lastError: 'boom' });
  });

  it('deactivates and removes by connection', async () => {
    const index = masterBankFeedIndex(master);
    await index.upsert([row({ providerConnectionId: 'item_x', connectionId: 'bkc_x' })]);
    await index.setActive('bkc_x', false, null);
    expect((await master.select().from(t).where(eq(t.connectionId, 'bkc_x')))[0]?.isActive).toBe(false);
    await index.remove('bkc_x');
    expect(await master.select().from(t).where(eq(t.connectionId, 'bkc_x'))).toEqual([]);
  });

  it('does nothing for an empty batch', async () => {
    await expect(masterBankFeedIndex(master).upsert([])).resolves.toBeUndefined();
  });
});
