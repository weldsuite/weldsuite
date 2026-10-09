/**
 * Optimistic-concurrency tests for `updatePerson` (`version` alias of
 * `ifVersion`, atomic conditional write). Kept apart from
 * `people-pglite.test.ts` so it stays independent of the broader people suite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPerson, updatePerson, PersonVersionConflictError } from './people';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('updatePerson · version conflict', () => {
  it('accepts `version` as an alias of ifVersion and 409s on a stale one', async () => {
    const p = await createPerson(db, { firstName: 'Ver', lastName: 'Alias' });
    await expect(updatePerson(db, p.id, { firstName: 'Stale', version: 9 })).rejects.toBeInstanceOf(
      PersonVersionConflictError,
    );
    const ok = await updatePerson(db, p.id, { firstName: 'Fresh', version: 1 });
    expect(ok?.row.version).toBe(2);
    // No version sent: unconditional, as before.
    const unconditional = await updatePerson(db, p.id, { firstName: 'Anything' });
    expect(unconditional?.row.version).toBe(3);
  });

  it('two writers pinned to the same version: exactly one wins', async () => {
    const p = await createPerson(db, { firstName: 'Race', lastName: 'Person' });
    const results = await Promise.allSettled([
      updatePerson(db, p.id, { firstName: 'A', version: 1 }),
      updatePerson(db, p.id, { firstName: 'B', version: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(PersonVersionConflictError);
  });
});
