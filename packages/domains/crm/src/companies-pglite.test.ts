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
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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
    expect(parties).toHaveLength(1);
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

  it('updateCompany accepts `version` as an alias of ifVersion and never writes it as a column', async () => {
    const c = await createCompany(db, { name: 'Version Alias' });
    await expect(
      updateCompany(db, c.id, { name: 'Stale', version: 7 }),
    ).rejects.toBeInstanceOf(CompanyVersionConflictError);

    const ok = await updateCompany(db, c.id, { name: 'Fresh', version: 1 });
    expect(ok?.row.version).toBe(2);
    expect(ok?.row.name).toBe('Fresh');

    // Omitting the version keeps the unconditional behaviour.
    const unconditional = await updateCompany(db, c.id, { name: 'No Version Sent' });
    expect(unconditional?.row.version).toBe(3);
  });

  it('a pinned-version update loses to a concurrent write (atomic WHERE version = ?)', async () => {
    const c = await createCompany(db, { name: 'Race' });
    const { companies } = schema;
    // Two writers pinned to the same version: exactly one may win.
    const results = await Promise.allSettled([
      updateCompany(db, c.id, { name: 'Writer A', version: 1 }),
      updateCompany(db, c.id, { name: 'Writer B', version: 1 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(CompanyVersionConflictError);
    const [row] = await db.select().from(companies).where(eq(companies.id, c.id));
    expect(row?.version).toBe(2);
  });

  describe('customer status validation', () => {
    it('rejects an unconfigured status on create and update, accepts built-ins and configured slugs', async () => {
      await expect(createCompany(db, { name: 'Bad Status', status: 'bogus' })).rejects.toMatchObject({
        name: 'InvalidStatusError',
      });
      const created = await createCompany(db, { name: 'Default Status Co' });
      expect(created.status).toBe('prospect');
      await expect(updateCompany(db, created.id, { status: 'bogus' })).rejects.toMatchObject({
        name: 'InvalidStatusError',
      });
      const builtin = await updateCompany(db, created.id, { status: 'churned' });
      expect(builtin?.row.status).toBe('churned');

      await db.insert(schema.crmCustomerStatuses).values({
        id: 'cs_vip_test',
        name: 'VIP Partner',
        slug: 'vip_partner',
        color: 'purple',
      });
      const custom = await updateCompany(db, created.id, { status: 'vip_partner' });
      expect(custom?.row.status).toBe('vip_partner');
    });

    it('bulkUpdateCompanies rejects an unconfigured status', async () => {
      const c = await createCompany(db, { name: 'Bulk Status' });
      await expect(
        bulkUpdateCompanies(db, { companyIds: [c.id], updates: { status: 'bogus' } }),
      ).rejects.toMatchObject({ name: 'InvalidStatusError' });
    });
  });

  describe('importCompanies validation', () => {
    it('reports bad rows per row instead of failing the batch, and keeps good rows', async () => {
      const res = await importCompanies(db, [
        { name: 'Import Good', website: 'good-import.com', employeeCount: '11-50' },
        { name: 'Import Bad Website', website: 'not a url' },
        { name: 'Import Bad Employees', employeeCount: 'abc' },
        { name: 'Import Bad Status', status: 'bogus' },
        { name: 'Import Bad Stage', lifecycleStage: 'nonsense' },
        { name: 'Import Bad Email', email: 'nope' },
      ]);
      expect(res.total).toBe(6);
      expect(res.imported).toBe(1);
      expect(res.failed).toBe(5);
      expect(res.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6]);
      expect(res.errors[0]!.error).toMatch(/Website must be a valid URL/);
      expect(res.errors[1]!.error).toMatch(/Employees must be a number or a range/);
      expect(res.errors[2]!.error).toMatch(/Unknown status "bogus"/);
      expect(res.errors[3]!.error).toMatch(/Lifecycle stage must be one of/);
      expect(res.errors[4]!.error).toMatch(/Email must be a valid email/);
      // The good row was normalized exactly like createCompany would.
      expect(res.changedRows[0]!.row.website).toBe('https://good-import.com');
    });

    it('accepts configured statuses by slug or display name, case-insensitively; blank status falls back to the default', async () => {
      await db.insert(schema.crmCustomerStatuses).values({
        id: 'cs_gold_test',
        name: 'Gold Tier',
        slug: 'gold_tier',
        color: 'yellow',
      });
      const res = await importCompanies(db, [
        { name: 'Status Slug Co', status: 'gold_tier' },
        { name: 'Status Label Co', status: 'gold tier' },
        { name: 'Status Builtin Co', status: 'Active' },
        { name: 'Status Blank Co', status: '' },
      ]);
      expect(res.failed).toBe(0);
      expect(res.changedRows.map((r) => r.row.status)).toEqual(['gold_tier', 'gold_tier', 'active', 'prospect']);
    });

    it('defaults ownerId to the importing user for new rows only', async () => {
      const first = await importCompanies(
        db,
        [{ partyCode: 'IMP-OWNER-1', name: 'Owned By Importer' }],
        { defaultOwnerId: 'user_importer' },
      );
      expect(first.changedRows[0]!.row.ownerId).toBe('user_importer');

      // Re-importing as someone else updates the row but must not steal ownership.
      const second = await importCompanies(
        db,
        [{ partyCode: 'IMP-OWNER-1', industry: 'Software' }],
        { defaultOwnerId: 'user_someone_else' },
      );
      expect(second.updated).toBe(1);
      expect(second.changedRows[0]!.row.ownerId).toBe('user_importer');
    });
  });

  // ---------------------------------------------------------------------------
  // Owner-scope isolation tests
  // ---------------------------------------------------------------------------

  describe('owner scope isolation', () => {
    const ownerA = 'user_scope_a';
    const ownerB = 'user_scope_b';

    // createCompany/updateCompany/bulkUpdateCompanies now validate ownerId
    // against workspace_members (TASK-914) — seed both test owners as real
    // members so the ownership-scope assertions below still exercise the
    // scoping logic rather than tripping the new validation.
    beforeAll(async () => {
      const { workspaceMembers } = schema;
      for (const userId of [ownerA, ownerB]) {
        await db.insert(workspaceMembers).values({
          id: `wm_${userId}`,
          userId,
          name: userId,
          role: 'MEMBER',
        });
      }
    });

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
