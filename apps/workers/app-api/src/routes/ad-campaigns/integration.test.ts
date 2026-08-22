import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { adCampaignsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { ensureAdTables } from '../../test/ad-ddl';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await ensureAdTables(db);
}, 60_000);

describe('/api/ad-campaigns · pglite integration', () => {
  it('GET / lists campaigns for an account', async () => {
    const accountId = generateId('adac');
    const now = new Date();
    await db.execute(sql.raw(`
      INSERT INTO ad_accounts (id, connection_id, platform_account_id, name, is_selected, created_at, updated_at)
      VALUES ('${accountId}', 'adcn_test', 'act_1', 'Main', true, now(), now())
    `));
    await db.execute(sql.raw(`
      INSERT INTO ad_campaigns (id, ad_account_id, platform_campaign_id, name, status, metrics, created_at, updated_at)
      VALUES ('${generateId('adcp')}', '${accountId}', 'cmp_1', 'Brand', 'ACTIVE', '{"spend":"5"}', now(), now())
    `));

    const { request } = createTestApp('/api/ad-campaigns', adCampaignsRoutes, {
      context: { permissions: permissions('ad_campaigns:read'), tenantDb: db },
    });

    const res = await request('/api/ad-campaigns');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]?.name).toBe('Brand');
  });
});
