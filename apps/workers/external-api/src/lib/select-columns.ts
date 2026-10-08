/**
 * Column projection for the generic routes.
 *
 * `db.select().from(table)` loads every column. For the tables that hold
 * ciphertext (a party's TIN, an entity's SSN, a bank account number) that
 * would put the blob in the response, so generic list/get/create/update go
 * through `columnsFor`, which leaves those columns out of the SELECT (and the
 * RETURNING) altogether: they are never read, so they cannot be returned,
 * logged or published.
 *
 * `omit` names extra property names to leave out on top of the sensitive ones
 * the table is known by (see `@weldsuite/db/lib/sensitive-columns`).
 */

import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { selectableColumns } from '@weldsuite/db/lib/sensitive-columns';

/**
 * Column map for `db.select(map)` / `.returning(map)`, or `undefined` when the
 * table has nothing to leave out (`db.select(undefined)` selects everything).
 */
export function columnsFor(table: unknown, omit: readonly string[] = []): Record<string, unknown> | undefined {
  const t = table as Table;
  return selectableColumns(getTableName(t), getTableColumns(t), omit);
}
