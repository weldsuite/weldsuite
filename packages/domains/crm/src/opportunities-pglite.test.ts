/**
 * pglite-backed service tests for `opportunities.ts`: create defaults,
 * won/lost ↔ stage sync (TASK-919), and unknown-stage handling for
 * `moveOpportunityStage` (the WeldConnect `move_deal_stage` step).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  buildUpdatePayload,
  createOpportunity,
  moveOpportunityStage,
  UnknownPipelineStageError,
} from './opportunities';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

async function seedStage(fields: Partial<typeof schema.crmPipelineStages.$inferInsert> = {}) {
  const id = generateId('stg');
  await db.insert(schema.crmPipelineStages).values({
    id,
    name: fields.name ?? 'Stage',
    pipeline: fields.pipeline ?? 'default',
    position: fields.position ?? 0,
    isWon: fields.isWon ?? false,
    isLost: fields.isLost ?? false,
    probability: fields.probability ?? 50,
  });
  return id;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('opportunities service · pglite integration', () => {
  it('defaults stage/status/pipeline and leaves the close date empty (TASK-671)', async () => {
    const result = await createOpportunity(db, { name: 'Acme Deal', customerId: 'cust_1' }, 'user_1');
    expect(result.row.stage).toBe('prospecting');
    expect(result.row.status).toBe('open');
    expect(result.row.pipeline).toBe('default');
    expect(result.row.ownerId).toBe('user_1');
    expect(result.row.amount).toBe('0');
    expect(result.row.closeDate).toBeNull();
    const [stored] = await db
      .select({ closeDate: schema.crmOpportunities.closeDate })
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, result.id));
    expect(stored?.closeDate).toBeNull();
    expect(result.eventData).toMatchObject({ id: result.id, name: 'Acme Deal', stage: 'prospecting', status: 'open' });
  });

  it('stores a close date when one is given and clears it with an empty string', async () => {
    const result = await createOpportunity(
      db,
      { name: 'Dated Deal', customerId: 'cust_1', closeDate: '2026-11-08T00:00:00.000Z' },
      'user_1',
    );
    expect(result.row.closeDate?.toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(buildUpdatePayload({ closeDate: '' }).closeDate).toBeNull();
    expect(buildUpdatePayload({ closeDate: null }).closeDate).toBeNull();
  });

  it('throws when neither ownerId nor an acting user is given', async () => {
    await expect(createOpportunity(db, { name: 'No Owner', customerId: 'cust_1' })).rejects.toThrow('ownerId required');
  });

  it('moving onto an isWon stage marks the deal won and stamps actualCloseDate', async () => {
    const wonStage = await seedStage({ isWon: true, probability: 100 });
    const { id } = await createOpportunity(db, { name: 'Win Me', customerId: 'cust_1' }, 'user_1');

    const result = await moveOpportunityStage(db, id, wonStage, 'user_1');
    expect(result?.row.status).toBe('won');
    expect(result?.row.probability).toBe(100);
    expect(result?.row.actualCloseDate).toBeInstanceOf(Date);
    expect(result?.events.map((e) => e.action)).toEqual(expect.arrayContaining(['updated', 'stage_changed', 'won']));

    const [persisted] = await db.select().from(schema.crmOpportunities).where(eq(schema.crmOpportunities.id, id));
    expect(persisted?.status).toBe('won');
    expect(persisted?.stageId).toBe(wonStage);
  });

  it('moving back to an open stage reopens a won/lost deal', async () => {
    const wonStage = await seedStage({ isWon: true });
    const openStage = await seedStage({ isWon: false, isLost: false });
    const { id } = await createOpportunity(db, { name: 'Reopen Me', customerId: 'cust_1' }, 'user_1');
    await moveOpportunityStage(db, id, wonStage, 'user_1');

    const reopened = await moveOpportunityStage(db, id, openStage, 'user_1');
    expect(reopened?.row.status).toBe('open');
    expect(reopened?.row.actualCloseDate).toBeNull();
  });

  it('throws UnknownPipelineStageError for a stage that does not exist', async () => {
    const { id } = await createOpportunity(db, { name: 'Bad Stage', customerId: 'cust_1' }, 'user_1');
    await expect(moveOpportunityStage(db, id, 'stg_missing', 'user_1')).rejects.toBeInstanceOf(
      UnknownPipelineStageError,
    );
  });

  it('returns null when the deal is out of ownerScope', async () => {
    const stage = await seedStage();
    const { id } = await createOpportunity(db, { name: 'Scoped', customerId: 'cust_1' }, 'owner_a');
    const result = await moveOpportunityStage(db, id, stage, 'owner_b');
    expect(result).toBeNull();
  });
});
