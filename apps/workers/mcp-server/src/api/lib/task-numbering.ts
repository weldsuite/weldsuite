/**
 * Task numbering — workspace-wide sequential numbers displayed as TASK-<number>.
 *
 * Mirrors `apps/workers/app-api/src/services/task-numbering.ts`. Tasks created
 * through MCP tools must get a number too, otherwise a row created here is
 * the only one in the workspace a user cannot refer to as TASK-<n>.
 *
 * Allocation is race-free: a single upsert increments `next_value` atomically
 * and RETURNING hands back the post-increment row, so concurrent creates each
 * get a distinct value with no select-then-update window.
 */
import { sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from './id';

const SCOPE = 'task';
const PREFIX = 'TASK-';

/**
 * Format a task row's number for presentation, e.g. 1042 → "TASK-1042".
 *
 * The presenter (`lib/present.ts`) is entity-agnostic — it would render the raw
 * integer as "Number: 1042", which is not the string a user reads off the
 * WeldFlow UI. Formatting here keeps the prefix out of the generic presenter,
 * where it would also mis-label invoice and ticket numbers.
 *
 * This applies to the MCP server's own resource API only; the wire format of
 * `external-api` keeps `number` as an integer.
 */
export function presentTaskNumber<T extends Record<string, unknown>>(
  row: T,
): Omit<T, 'number'> & { number?: string } {
  if (typeof row.number !== 'number') return row as Omit<T, 'number'> & { number?: string };
  return { ...row, number: `${PREFIX}${row.number}` };
}

/** Allocate a single task number. */
export async function allocateTaskNumber(db: Database): Promise<number> {
  const seq = schema.taskNumberSequences;
  const [row] = await db
    .insert(seq)
    .values({
      id: generateId('seq'),
      scope: SCOPE,
      prefix: PREFIX,
      // First allocation hands out 1, so the next stored value is 2.
      nextValue: 2,
    })
    .onConflictDoUpdate({
      target: seq.scope,
      set: {
        nextValue: sql`${seq.nextValue} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  // The upsert always inserts or updates exactly one row, so this is
  // unreachable in practice — but RETURNING is typed as an array, and failing
  // loudly beats handing back a NaN number that would violate the unique index.
  if (!row) throw new Error('Failed to allocate task number: sequence upsert returned no row');
  // `row.nextValue` is the post-increment value; the number just allocated is
  // the one immediately below it.
  return row.nextValue - 1;
}
