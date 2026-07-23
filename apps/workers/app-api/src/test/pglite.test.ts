/**
 * Smoke test for the pglite-backed test database. Validates that the
 * test infrastructure can spin up a real PostgreSQL in-process, push
 * the WeldSuite tenant schema, and let services execute against it.
 *
 * This is the gate that unlocks Phase 2 happy-path + tenant-isolation
 * tests for routes that talk directly to Drizzle. If it passes, the
 * pattern below extends to every entity.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { createCompany, getCompany } from '../services/companies';

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
}, 60_000);

afterAll(async () => {
  if (close) await close();
});

describe('pglite harness', () => {
  it('creates a company and reads it back', async () => {
    const created = await createCompany(db, { name: 'Acme E2E pglite' });
    expect(created.id).toMatch(/^company_/);
    expect(created.displayName).toBe('Acme E2E pglite');

    const fetched = await getCompany(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('Acme E2E pglite');
  });

  it('soft-deleted rows are invisible to getCompany', async () => {
    const created = await createCompany(db, { name: 'Disappearing Co.' });
    // Tagging deletedAt directly — soft delete contract.
    const { schema } = await import('../db');
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.companies)
      .set({ deletedAt: new Date() })
      .where(eq(schema.companies.id, created.id));

    const fetched = await getCompany(db, created.id);
    expect(fetched).toBeNull();
  });
});
