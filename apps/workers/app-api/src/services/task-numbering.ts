/**
 * Task numbering — workspace-wide sequential numbers displayed as TASK-<number>.
 *
 * Allocation is race-free: a single upsert increments `next_value` atomically
 * and RETURNING hands back the post-increment row, so concurrent creates each
 * get a distinct value with no select-then-update window (same technique as
 * accounting's `nextEntityNumber`). Callers store the raw integer; the UI
 * formats it as TASK-<n>.
 */
import { sql } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';

const SCOPE = 'task';
const PREFIX = 'TASK-';

/** Allocate a single task number. */
export async function allocateTaskNumber(db: any): Promise<number> {
  return (await allocateTaskNumbers(db, 1))[0];
}

/**
 * Allocate `count` consecutive task numbers in one atomic bump.
 *
 * Bumps `next_value` by `count` and derives the contiguous block from the
 * returned post-increment value — a bulk import of N rows costs one round-trip,
 * not N. Returns an ascending array of the allocated numbers.
 */
export async function allocateTaskNumbers(db: any, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const seq = schema.taskNumberSequences;
  const [row] = await db
    .insert(seq)
    .values({
      id: generateId('seq'),
      scope: SCOPE,
      prefix: PREFIX,
      // First allocation of `count` hands out 1..count, so next stored value is count + 1.
      nextValue: count + 1,
    })
    .onConflictDoUpdate({
      target: seq.scope,
      set: {
        nextValue: sql`${seq.nextValue} + ${count}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  // `row.nextValue` is the post-increment value; the block is the `count`
  // integers ending just below it.
  const end = row.nextValue - 1; // highest number allocated
  const start = end - count + 1; // lowest number allocated
  return Array.from({ length: count }, (_, i) => start + i);
}
