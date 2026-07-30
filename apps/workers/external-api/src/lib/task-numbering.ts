/**
 * Task numbering — workspace-wide sequential numbers displayed as TASK-<number>.
 *
 * Mirrors `apps/workers/app-api/src/services/task-numbering.ts`. Tasks created
 * through the public API must get a number too, otherwise a row created here is
 * the only one in the workspace a user cannot refer to as TASK-<n>.
 *
 * Allocation is race-free: a single upsert increments `next_value` atomically
 * and RETURNING hands back the post-increment row, so concurrent creates each
 * get a distinct value with no select-then-update window.
 */
import { sql } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from './id';

const SCOPE = 'task';
const PREFIX = 'TASK-';

/** Allocate a single task number. */
export async function allocateTaskNumber(db: any): Promise<number> {
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
  // `row.nextValue` is the post-increment value; the number just allocated is
  // the one immediately below it.
  return row.nextValue - 1;
}
