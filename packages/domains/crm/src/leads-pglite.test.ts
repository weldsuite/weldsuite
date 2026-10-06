/**
 * pglite-backed service tests for `leads.ts`. Mirrors
 * `people-pglite.test.ts` / `companies-pglite.test.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createLead, leadEventFields } from './leads';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { eq } from 'drizzle-orm';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('leads service · pglite integration', () => {
  it('derives fullName, defaults source/status/score, and owns the actor when no ownerId is given', async () => {
    const result = await createLead(
      db,
      { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      'user_1',
    );
    expect(result.row.fullName).toBe('Ada Lovelace');
    expect(result.row.source).toBe('other');
    expect(result.row.status).toBe('new');
    expect(result.row.score).toBe(0);
    expect(result.row.ownerId).toBe('user_1');

    const [persisted] = await db.select().from(schema.crmLeads).where(eq(schema.crmLeads.id, result.id));
    expect(persisted).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' });
  });

  it('an explicit ownerId wins over the acting user', async () => {
    const result = await createLead(db, { email: 'owned@example.test', ownerId: 'owner_2' }, 'user_1');
    expect(result.row.ownerId).toBe('owner_2');
  });

  it('eventData carries the LEAD_EVENT_FIELDS projection plus id/email/status', async () => {
    const result = await createLead(db, { firstName: 'Grace', email: 'grace@example.test', companyName: 'Acme' }, 'user_1');
    expect(result.eventData).toMatchObject({
      id: result.id,
      email: 'grace@example.test',
      status: 'new',
      firstName: 'Grace',
      companyName: 'Acme',
    });
    expect(result.eventData).toEqual({ ...leadEventFields(result.row), id: result.id, email: 'grace@example.test', status: 'new' });
  });
});
