/**
 * pglite-backed service tests for `services/people.ts`. Mirrors
 * `companies-pglite.test.ts` — covers archive/unarchive,
 * findOrCreateByEmail idempotency, list filters, version-conflict.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createPerson,
  getPerson,
  updatePerson,
  archivePerson,
  unarchivePerson,
  deletePerson,
  listPeople,
  importPeople,
  findOrCreatePersonByEmail,
  addPersonToCrm,
  PersonVersionConflictError,
  exportPeople,
  bulkUpdatePeople,
} from './people';
import { createPgliteDb } from '../test/pglite';
import type { Database } from '../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('people service · pglite integration', () => {
  it('derives fullName from first/last and stamps displayName', async () => {
    const p = await createPerson(db, { firstName: 'Alex', lastName: 'Stamper' });
    expect(p.fullName).toBe('Alex Stamper');
    expect(p.displayName).toBe('Alex Stamper');
  });

  it('updatePerson throws PersonVersionConflictError on stale ifVersion', async () => {
    const p = await createPerson(db, { firstName: 'Lock', lastName: 'Test' });
    expect(p.version).toBe(1);

    await expect(
      updatePerson(db, p.id, { firstName: 'New', ifVersion: 99 }),
    ).rejects.toBeInstanceOf(PersonVersionConflictError);

    const ok = await updatePerson(db, p.id, { firstName: 'New', ifVersion: 1 });
    expect(ok?.row.version).toBe(2);
  });

  it('archive sets archivedAt; unarchive clears it', async () => {
    const p = await createPerson(db, { firstName: 'Arch', lastName: 'Test' });
    const archived = await archivePerson(db, p.id);
    expect(archived?.archivedAt).toBeInstanceOf(Date);

    const unarchived = await unarchivePerson(db, p.id);
    expect(unarchived?.archivedAt).toBeNull();
  });

  it('findOrCreatePersonByEmail is idempotent — same email returns same id', async () => {
    const email = `dedupe-${Date.now()}@e2e.test`;
    const first = await findOrCreatePersonByEmail(db, { email });
    const second = await findOrCreatePersonByEmail(db, { email });
    expect(first.id).toBe(second.id);
  });

  it('findOrCreatePersonByEmail matches case-insensitively', async () => {
    const email = `Case-${Date.now()}@e2e.TEST`;
    const first = await findOrCreatePersonByEmail(db, { email });
    const second = await findOrCreatePersonByEmail(db, { email: email.toLowerCase() });
    expect(first.id).toBe(second.id);
  });

  it('deletePerson hides the row from getPerson + listPeople', async () => {
    const p = await createPerson(db, { firstName: 'Vanishing', lastName: 'P' });
    await deletePerson(db, p.id);

    expect(await getPerson(db, p.id)).toBeNull();

    const list = await listPeople(db, { search: 'Vanishing', limit: 50 });
    expect(list.data.find((r) => r.id === p.id)).toBeUndefined();
  });

  it('importPeople persists extra fields, parses dateOfBirth, and stores custom fields', async () => {
    const res = await importPeople(db, [
      {
        partyCode: 'P-IMP-1',
        firstName: 'Dana',
        lastName: 'Imported',
        gender: 'female',
        dateOfBirth: '1990-05-20',
        alternateEmails: ['dana.alt@imp.example'],
        extension: '123',
        influenceLevel: 'high',
        bestTimeToContact: 'mornings',
        customFields: { tier: 'gold' },
      },
    ]);

    expect(res.imported).toBe(1);
    const row = res.changedRows[0]!.row;
    expect(row.gender).toBe('female');
    expect(row.dateOfBirth).toBeInstanceOf(Date);
    expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-05-20');
    expect(row.alternateEmails).toEqual(['dana.alt@imp.example']);
    expect(row.extension).toBe('123');
    expect(row.influenceLevel).toBe('high');
    expect(row.bestTimeToContact).toBe('mornings');
    expect(row.customFields).toEqual({ tier: 'gold' });
  });

  it('importPeople upsert merges custom fields, preserving untouched keys', async () => {
    const first = await importPeople(db, [
      { partyCode: 'P-MERGE-1', firstName: 'Mer', lastName: 'Ge', customFields: { a: '1', b: '2' } },
    ]);
    expect(first.imported).toBe(1);

    const second = await importPeople(db, [
      { partyCode: 'P-MERGE-1', customFields: { b: '20', c: '3' } },
    ]);
    expect(second.updated).toBe(1);
    expect(second.changedRows[0]!.row.customFields).toEqual({ a: '1', b: '20', c: '3' });
  });

  // ---------------------------------------------------------------------------
  // CRM membership (inCrm) — auto-created mail/helpdesk identities stay out of
  // the CRM until explicitly added.
  // ---------------------------------------------------------------------------

  describe('CRM membership', () => {
    it('createPerson defaults to inCrm=true (CRM-created contact)', async () => {
      const p = await createPerson(db, { firstName: 'Crm', lastName: 'Member' });
      expect(p.inCrm).toBe(true);
    });

    it('findOrCreatePersonByEmail creates the guest with inCrm=false', async () => {
      const email = `guest-${Date.now()}@e2e.test`;
      const resolved = await findOrCreatePersonByEmail(db, { email });
      const row = await getPerson(db, resolved.id);
      expect(row?.inCrm).toBe(false);
    });

    it('listPeople with inCrm=true hides mail-only identities', async () => {
      const email = `hidden-${Date.now()}@e2e.test`;
      const guest = await findOrCreatePersonByEmail(db, { email });
      const member = await createPerson(db, { firstName: 'Visible', lastName: 'Member' });

      const crmOnly = await listPeople(db, { limit: 100, inCrm: true });
      const ids = crmOnly.data.map((r) => r.id);
      expect(ids).toContain(member.id);
      expect(ids).not.toContain(guest.id);

      // Without the filter, the guest is still resolvable (mail autocomplete).
      const all = await listPeople(db, { limit: 100 });
      expect(all.data.map((r) => r.id)).toContain(guest.id);
    });

    it('addPersonToCrm flips inCrm to true and assigns the acting owner', async () => {
      const email = `promote-${Date.now()}@e2e.test`;
      const guest = await findOrCreatePersonByEmail(db, { email });
      expect((await getPerson(db, guest.id))?.inCrm).toBe(false);

      const promoted = await addPersonToCrm(db, guest.id, 'user_actor_1');
      expect(promoted?.inCrm).toBe(true);
      expect(promoted?.ownerId).toBe('user_actor_1');

      // Now visible in the CRM grid.
      const crmOnly = await listPeople(db, { limit: 100, inCrm: true });
      expect(crmOnly.data.map((r) => r.id)).toContain(guest.id);
    });

    it('addPersonToCrm is idempotent and returns null for unknown ids', async () => {
      const p = await createPerson(db, { firstName: 'Already', lastName: 'In', ownerId: 'owner_keep' });
      const again = await addPersonToCrm(db, p.id, 'someone_else');
      expect(again?.inCrm).toBe(true);
      // Existing owner is preserved, not overwritten by the acting user.
      expect(again?.ownerId).toBe('owner_keep');

      expect(await addPersonToCrm(db, 'person_does_not_exist', 'x')).toBeNull();
    });

    it('addPersonToCrm owner-scope: a scoped user may promote unowned + own rows, never others', async () => {
      const scoped = 'user_scoped_crm';
      const guest = await findOrCreatePersonByEmail(db, { email: `scoped-guest-${Date.now()}@e2e.test` });
      const owned = await createPerson(db, { firstName: 'My', lastName: 'Own', ownerId: scoped });
      const foreign = await createPerson(db, { firstName: 'Not', lastName: 'Mine', ownerId: 'other_owner' });

      // Unowned mail identity → allowed, and the scoped user becomes owner.
      const promotedGuest = await addPersonToCrm(db, guest.id, scoped, scoped);
      expect(promotedGuest?.inCrm).toBe(true);
      expect(promotedGuest?.ownerId).toBe(scoped);

      // Own row → allowed.
      expect((await addPersonToCrm(db, owned.id, scoped, scoped))?.inCrm).toBe(true);

      // Row owned by someone else → not matched, no mutation.
      expect(await addPersonToCrm(db, foreign.id, scoped, scoped)).toBeNull();
      expect((await getPerson(db, foreign.id))?.inCrm).toBe(true); // unchanged default
      expect((await getPerson(db, foreign.id))?.ownerId).toBe('other_owner');
    });
  });

  // ---------------------------------------------------------------------------
  // Owner-scope isolation tests
  // ---------------------------------------------------------------------------

  describe('owner scope isolation', () => {
    const ownerA = 'user_pscope_a';
    const ownerB = 'user_pscope_b';

    it('listPeople with ownerScope only returns owned rows', async () => {
      await createPerson(db, { firstName: 'Alice', lastName: 'ScopeA', ownerId: ownerA });
      await createPerson(db, { firstName: 'Bob', lastName: 'ScopeB', ownerId: ownerB });

      const scopedA = await listPeople(db, { limit: 50 }, ownerA);
      const names = scopedA.data.map((r) => r.displayName);
      expect(names.some((n) => n.includes('ScopeA'))).toBe(true);
      expect(names.some((n) => n.includes('ScopeB'))).toBe(false);
    });

    it('listPeople without ownerScope returns all rows', async () => {
      const all = await listPeople(db, { limit: 50 });
      const names = all.data.map((r) => r.displayName);
      expect(names.some((n) => n.includes('ScopeA'))).toBe(true);
      expect(names.some((n) => n.includes('ScopeB'))).toBe(true);
    });

    it('getPerson with ownerScope: owned row is returned', async () => {
      const p = await createPerson(db, { firstName: 'GetA', lastName: 'Owner', ownerId: ownerA });
      const found = await getPerson(db, p.id, ownerA);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(p.id);
    });

    it('getPerson with ownerScope: cross-owner row returns null', async () => {
      const p = await createPerson(db, { firstName: 'GetB', lastName: 'Other', ownerId: ownerB });
      const notFound = await getPerson(db, p.id, ownerA);
      expect(notFound).toBeNull();
    });

    it('exportPeople with ownerScope only exports owned rows', async () => {
      const rows = await exportPeople(db, {}, ownerA);
      expect(rows.every((r) => r.ownerId === ownerA || r.ownerId === null)).toBe(true);
    });

    it('updatePerson with ownerScope: cross-owner update returns null', async () => {
      const p = await createPerson(db, { firstName: 'Update', lastName: 'Other', ownerId: ownerB });
      const result = await updatePerson(db, p.id, { firstName: 'Hacked' }, ownerA);
      expect(result).toBeNull();
      // Original row is unchanged
      const unchanged = await getPerson(db, p.id);
      expect(unchanged?.firstName).toBe('Update');
    });

    it('bulkUpdatePeople with ownerScope: cross-owner ids become failed', async () => {
      const pA = await createPerson(db, { firstName: 'BulkA', lastName: 'P', ownerId: ownerA });
      const pB = await createPerson(db, { firstName: 'BulkB', lastName: 'P', ownerId: ownerB });

      const result = await bulkUpdatePeople(
        db,
        { personIds: [pA.id, pB.id], updates: { status: 'inactive' } },
        ownerA,
      );

      // Only ownerA's row should be updated
      expect(result.updated).toBe(1);
      expect(result.failed.find((f) => f.id === pB.id)).toBeTruthy();
    });
  });
});
