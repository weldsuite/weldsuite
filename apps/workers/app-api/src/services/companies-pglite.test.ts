/**
 * pglite-backed service tests for `services/companies.ts`. Exercises
 * the same flows that the route integration tests cover but at the
 * service layer — surface-area changes (route reshuffles, middleware
 * order) won't affect these.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createCompany,
  getCompany,
  updateCompany,
  archiveCompany,
  unarchiveCompany,
  deleteCompany,
  listCompanies,
  importCompanies,
  CompanyVersionConflictError,
  exportCompanies,
  bulkUpdateCompanies,
} from './companies';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('companies service · pglite integration', () => {
  it('creates with displayName derived from tradingName', async () => {
    const c = await createCompany(db, {
      name: 'Long Legal Name LLC',
      tradingName: 'Acme',
    });
    expect(c.displayName).toBe('Acme');
  });

  it('updateCompany throws CompanyVersionConflictError on stale ifVersion', async () => {
    const c = await createCompany(db, { name: 'Optimistic Lock' });
    expect(c.version).toBe(1);

    await expect(
      updateCompany(db, c.id, { name: 'New Name', ifVersion: 99 }),
    ).rejects.toBeInstanceOf(CompanyVersionConflictError);

    // Real version increments to 2 on successful update.
    const ok = await updateCompany(db, c.id, { name: 'New Name', ifVersion: 1 });
    expect(ok?.row.version).toBe(2);
  });

  it('archive sets archivedAt; unarchive clears it', async () => {
    const c = await createCompany(db, { name: 'Archive Test' });

    const archived = await archiveCompany(db, c.id);
    expect(archived?.archivedAt).toBeInstanceOf(Date);

    const unarchived = await unarchiveCompany(db, c.id);
    expect(unarchived?.archivedAt).toBeNull();
  });

  it('listCompanies filters by isSupplier', async () => {
    await createCompany(db, { name: 'Supplier Co', isSupplier: true });
    await createCompany(db, { name: 'Plain Co', isSupplier: false });

    const suppliers = await listCompanies(db, { isSupplier: true, limit: 50 });
    const names = suppliers.data.map((r) => r.name);
    expect(names).toContain('Supplier Co');
    expect(names).not.toContain('Plain Co');
  });

  it('listCompanies search matches name OR vatNumber OR email', async () => {
    await createCompany(db, { name: 'Findable Searchy', vatNumber: 'NL999' });

    const r1 = await listCompanies(db, { search: 'Findable', limit: 50 });
    expect(r1.data.find((r) => r.name === 'Findable Searchy')).toBeTruthy();

    const r2 = await listCompanies(db, { search: 'NL999', limit: 50 });
    expect(r2.data.find((r) => r.vatNumber === 'NL999')).toBeTruthy();
  });

  it('deleteCompany hides the row from getCompany + listCompanies', async () => {
    const c = await createCompany(db, { name: 'Vanishing Co' });
    await deleteCompany(db, c.id);

    expect(await getCompany(db, c.id)).toBeNull();

    const list = await listCompanies(db, { search: 'Vanishing', limit: 50 });
    expect(list.data.find((r) => r.id === c.id)).toBeUndefined();
  });

  it('createCompany with isSupplier=true creates the wrapping party row', async () => {
    const c = await createCompany(db, {
      name: 'Wrapper Test Supplier',
      isSupplier: true,
    });

    const parties = await db
      .select()
      .from(schema.parties)
      .where(eq(schema.parties.companyId, c.id));
    expect(parties.length).toBe(1);
    expect(parties[0]?.role).toBe('supplier');
    expect(parties[0]?.displayName).toBe('Wrapper Test Supplier');
  });

  it('importCompanies persists the extra mapped fields and custom fields', async () => {
    const res = await importCompanies(db, [
      {
        partyCode: 'IMP-EXTRA-1',
        name: 'Importer Co',
        fax: '+31 20 000 0000',
        alternateEmails: ['alt@imp.example'],
        linkedinUrl: 'https://linkedin.com/company/imp',
        twitterHandle: '@imp',
        rating: 'A',
        preferredLanguage: 'nl',
        timezone: 'Europe/Amsterdam',
        internalNotes: 'imported note',
        customFields: { industry_code: '4321', vip: true },
      },
    ]);

    expect(res.imported).toBe(1);
    const row = res.changedRows[0]!.row;
    expect(row.fax).toBe('+31 20 000 0000');
    expect(row.alternateEmails).toEqual(['alt@imp.example']);
    expect(row.linkedinUrl).toBe('https://linkedin.com/company/imp');
    expect(row.twitterHandle).toBe('@imp');
    expect(row.rating).toBe('A');
    expect(row.preferredLanguage).toBe('nl');
    expect(row.timezone).toBe('Europe/Amsterdam');
    expect(row.internalNotes).toBe('imported note');
    expect(row.customFields).toEqual({ industry_code: '4321', vip: true });
  });

  it('importCompanies upsert merges custom fields, preserving untouched keys', async () => {
    const first = await importCompanies(db, [
      { partyCode: 'IMP-MERGE-1', name: 'Merge Co', customFields: { a: '1', b: '2' } },
    ]);
    expect(first.imported).toBe(1);

    // Re-import the same row mapping only some custom fields.
    const second = await importCompanies(db, [
      { partyCode: 'IMP-MERGE-1', customFields: { b: '20', c: '3' } },
    ]);
    expect(second.updated).toBe(1);
    expect(second.changedRows[0]!.row.customFields).toEqual({ a: '1', b: '20', c: '3' });
  });

  // ---------------------------------------------------------------------------
  // Owner-scope isolation tests
  // ---------------------------------------------------------------------------

  describe('owner scope isolation', () => {
    const ownerA = 'user_scope_a';
    const ownerB = 'user_scope_b';

    it('listCompanies with ownerScope only returns owned rows', async () => {
      await createCompany(db, { name: 'Scope A Co', ownerId: ownerA });
      await createCompany(db, { name: 'Scope B Co', ownerId: ownerB });

      const scopedA = await listCompanies(db, { limit: 50 }, ownerA);
      const names = scopedA.data.map((r) => r.name);
      expect(names).toContain('Scope A Co');
      expect(names).not.toContain('Scope B Co');
    });

    it('listCompanies without ownerScope returns all rows', async () => {
      const all = await listCompanies(db, { limit: 50 });
      const names = all.data.map((r) => r.name);
      expect(names).toContain('Scope A Co');
      expect(names).toContain('Scope B Co');
    });

    it('getCompany with ownerScope: owned row is returned', async () => {
      const c = await createCompany(db, { name: 'GetScope Owner', ownerId: ownerA });
      const found = await getCompany(db, c.id, ownerA);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(c.id);
    });

    it('getCompany with ownerScope: cross-owner row returns null', async () => {
      const c = await createCompany(db, { name: 'GetScope Other', ownerId: ownerB });
      const notFound = await getCompany(db, c.id, ownerA);
      expect(notFound).toBeNull();
    });

    it('exportCompanies with ownerScope only exports owned rows', async () => {
      const rows = await exportCompanies(db, {}, ownerA);
      const names = rows.map((r) => r.name);
      expect(names.every((n) => {
        // All exported rows must be owned by ownerA (or have null ownerId if any)
        const row = rows.find((r) => r.name === n)!;
        return row.ownerId === ownerA || row.ownerId === null;
      })).toBe(true);
      expect(names).not.toContain('Scope B Co');
    });

    it('updateCompany with ownerScope: cross-owner update returns null', async () => {
      const c = await createCompany(db, { name: 'Update Scope Other', ownerId: ownerB });
      const result = await updateCompany(db, c.id, { name: 'Hacked' }, ownerA);
      expect(result).toBeNull();
      // Original row is unchanged
      const unchanged = await getCompany(db, c.id);
      expect(unchanged?.name).toBe('Update Scope Other');
    });

    it('bulkUpdateCompanies with ownerScope: cross-owner ids become failed', async () => {
      const cA = await createCompany(db, { name: 'Bulk A', ownerId: ownerA });
      const cB = await createCompany(db, { name: 'Bulk B', ownerId: ownerB });

      const result = await bulkUpdateCompanies(
        db,
        { companyIds: [cA.id, cB.id], updates: { status: 'active' } },
        ownerA,
      );

      // Only ownerA's row should be updated
      expect(result.updated).toBe(1);
      expect(result.failed.find((f) => f.id === cB.id)).toBeTruthy();
    });
  });
});
