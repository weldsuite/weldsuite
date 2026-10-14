/**
 * pglite tests for the computed company attributes (Team, interactions,
 * connection strength, next due task, deals).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createCompany, updateCompany } from './companies';
import { connectionStrengthFor, getCompanyAttributes } from './company-attributes';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const NOW = new Date('2026-10-14T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
let seq = 0;
const id = (prefix: string) => `${prefix}_${++seq}`;

/** A company with a wrapping party (flagging it a supplier creates one). */
async function companyWithParty(name: string) {
  const company = await createCompany(db, { name, isSupplier: true });
  const [party] = await db.select().from(schema.parties).where(eq(schema.parties.companyId, company.id));
  if (!party) throw new Error('expected a wrapping party');
  return { company, partyId: party.id };
}

async function activity(partyId: string, values: Partial<typeof schema.crmActivities.$inferInsert>) {
  await db.insert(schema.crmActivities).values({
    id: id('act'),
    type: 'call',
    subject: 'Touch base',
    assignedToId: 'user_a',
    counterpartyId: partyId,
    status: 'completed',
    ...values,
  });
}

describe('getCompanyAttributes', () => {
  it('returns empty attributes for a company with nothing linked', async () => {
    const company = await createCompany(db, { name: 'Quiet Co' });
    const attrs = (await getCompanyAttributes(db, [company.id], NOW)).get(company.id);
    expect(attrs).toEqual({
      team: [],
      firstInteraction: null,
      lastInteraction: null,
      nextInteraction: null,
      connectionStrength: 'none',
      strongestConnectionUserId: null,
      nextDueTask: null,
      deals: [],
    });
  });

  it('computes team, interactions, connection, next due task and deals', async () => {
    const { company, partyId } = await companyWithParty('Busy Co');

    // Team: current people only.
    await db.insert(schema.people).values([
      { id: 'per_cur', displayName: 'Ada Current', email: 'ada@busy.co', directPhone: '+31 1', title: 'CTO' },
      { id: 'per_old', displayName: 'Old Timer' },
    ]);
    await db.insert(schema.personCompanies).values([
      { id: id('pc'), personId: 'per_cur', companyId: company.id, isPrimary: true },
      { id: id('pc'), personId: 'per_old', companyId: company.id, endedAt: daysAgo(400) },
    ]);

    // Interactions: three recent by user_b, one old by user_a, a future meeting,
    // a cancelled call and a note (neither counts).
    await activity(partyId, { assignedToId: 'user_a', type: 'email', startTime: daysAgo(200) });
    await activity(partyId, { assignedToId: 'user_b', startTime: daysAgo(30) });
    await activity(partyId, { assignedToId: 'user_b', startTime: daysAgo(10) });
    await activity(partyId, { assignedToId: 'user_b', type: 'meeting', startTime: daysAgo(2) });
    await activity(partyId, { assignedToId: 'user_c', type: 'meeting', status: 'planned', startTime: daysAgo(-3) });
    await activity(partyId, { status: 'cancelled', startTime: daysAgo(1) });
    await activity(partyId, { type: 'note', startTime: daysAgo(1) });

    // Tasks: the earliest open due date wins, done ones are skipped.
    await db.insert(schema.tasks).values([
      { id: id('task'), title: 'Send proposal', counterpartyId: partyId, status: 'todo', dueDate: daysAgo(-5) },
      { id: id('task'), title: 'Already done', counterpartyId: partyId, status: 'done', dueDate: daysAgo(-1) },
    ]);
    await activity(partyId, { type: 'task', subject: 'Call back', status: 'planned', dueDate: daysAgo(-2) });

    await db.insert(schema.crmOpportunities).values({
      id: id('opp'),
      name: 'Busy Co renewal',
      customerId: company.id,
      counterpartyId: partyId,
      ownerId: 'user_b',
      amount: '12500.00',
      currency: 'EUR',
      stage: 'proposal',
    });

    const attrs = (await getCompanyAttributes(db, [company.id], NOW)).get(company.id)!;

    expect(attrs.team).toEqual([
      { id: 'per_cur', name: 'Ada Current', email: 'ada@busy.co', phone: '+31 1', jobTitle: 'CTO' },
    ]);
    expect(attrs.firstInteraction).toEqual({ at: daysAgo(200).toISOString(), type: 'email', userId: 'user_a' });
    expect(attrs.lastInteraction).toEqual({ at: daysAgo(2).toISOString(), type: 'meeting', userId: 'user_b' });
    expect(attrs.nextInteraction).toEqual({ at: daysAgo(-3).toISOString(), type: 'meeting', userId: 'user_c' });
    expect(attrs.connectionStrength).toBe('good'); // 3 in the last 90 days
    expect(attrs.strongestConnectionUserId).toBe('user_b');
    expect(attrs.nextDueTask).toMatchObject({ title: 'Call back', dueDate: daysAgo(-2).toISOString() });
    expect(attrs.deals).toEqual([
      expect.objectContaining({ name: 'Busy Co renewal', stage: 'proposal', amount: 12500, currency: 'EUR', ownerId: 'user_b' }),
    ]);
  });
});

describe('connectionStrengthFor', () => {
  it('buckets by interactions in the last 90 days', () => {
    expect(connectionStrengthFor(12, true)).toBe('very_strong');
    expect(connectionStrengthFor(5, true)).toBe('strong');
    expect(connectionStrengthFor(2, true)).toBe('good');
    expect(connectionStrengthFor(1, true)).toBe('weak');
    expect(connectionStrengthFor(0, true)).toBe('very_weak');
    expect(connectionStrengthFor(0, false)).toBe('none');
  });
});

describe('new company fields', () => {
  it('stores the Attio-style fields and stamps createdBy on create', async () => {
    const company = await createCompany(
      db,
      {
        name: 'Fields Co',
        description: 'Makes fields',
        instagramUrl: 'https://instagram.com/fieldsco',
        angellistUrl: 'https://angel.co/company/fieldsco',
        twitterFollowerCount: 1200,
        annualRevenue: { amount: 2_000_000, currency: 'EUR' },
        fundingRaised: { amount: 5_000_000, currency: 'USD' },
        foundationDate: '2015-03-01T00:00:00.000Z',
      },
      { createdBy: 'user_creator' },
    );
    expect(company).toMatchObject({
      description: 'Makes fields',
      instagramUrl: 'https://instagram.com/fieldsco',
      angellistUrl: 'https://angel.co/company/fieldsco',
      twitterFollowerCount: 1200,
      annualRevenue: { amount: 2_000_000, currency: 'EUR' },
      fundingRaised: { amount: 5_000_000, currency: 'USD' },
      createdBy: 'user_creator',
    });
    expect(company.foundationDate?.toISOString()).toBe('2015-03-01T00:00:00.000Z');

    const updated = await updateCompany(db, company.id, { foundationDate: null, fundingRaised: null });
    expect(updated?.row.foundationDate).toBeNull();
    expect(updated?.row.fundingRaised).toBeNull();
  });
});
