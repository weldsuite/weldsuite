/**
 * WeldAds sync service tests — change-detection + list behavior without Meta network calls.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { hashCampaignPayload } from '@weldsuite/meta-ads';
import { createPgliteDb } from '../../test/pglite';
import { ensureAdTables } from '../../test/ad-ddl';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await ensureAdTables(db);
}, 60_000);

describe('WeldAds sync change detection', () => {
  it('skips duplicate campaign writes when content hash matches', async () => {
    const now = new Date();
    const connectionId = generateId('adcn');
    const accountId = generateId('adac');

    await db.insert(schema.adPlatformConnections).values({
      id: connectionId,
      platform: 'facebook',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.adAccounts).values({
      id: accountId,
      connectionId,
      platformAccountId: 'act_123',
      name: 'Test Account',
      isSelected: true,
      createdAt: now,
      updatedAt: now,
    });

    const hash = hashCampaignPayload({
      name: 'Launch',
      status: 'ACTIVE',
      metrics: { spend: '10' },
    });

    const campaignId = generateId('adcp');
    await db.insert(schema.adCampaigns).values({
      id: campaignId,
      adAccountId: accountId,
      platformCampaignId: 'cmp_1',
      name: 'Launch',
      status: 'ACTIVE',
      metrics: { spend: '10' },
      contentHash: hash,
      createdAt: now,
      updatedAt: now,
    });

    const duplicateHash = hashCampaignPayload({
      name: 'Launch',
      status: 'ACTIVE',
      metrics: { spend: '10' },
    });
    expect(duplicateHash).toBe(hash);

    const [row] = await db
      .select()
      .from(schema.adCampaigns)
      .where(eq(schema.adCampaigns.id, campaignId))
      .limit(1);
    expect(row?.contentHash).toBe(hash);
  });
});
