/**
 * Numbering — sequential numbers shown as plain numbers (e.g. 1042) or with a
 * prefix (RSK-4), allocated from `task_number_sequences`.
 *
 * Tasks share one workspace-wide sequence (scope `task`). Other objects use a
 * scope of their own: the RAID register numbers per project and kind
 * (`rsk:<projectId>`, see `./raid`). Every scope is its own row, so one
 * counter never touches another.
 *
 * Allocation is race-free: a single upsert increments `next_value` atomically
 * and RETURNING hands back the post-increment row, so concurrent creates each
 * get a distinct value with no select-then-update window (same technique as
 * accounting's `nextEntityNumber`). Callers store the raw integer and build the
 * display code from the prefix.
 */
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

/** One counter: its scope key (unique per row) and the prefix of the display code. */
export interface NumberSequence {
  scope: string;
  prefix: string;
}

/** The workspace-wide task sequence. */
export const TASK_SEQUENCE: NumberSequence = { scope: 'task', prefix: 'TASK-' };

/**
 * Allocate `count` consecutive numbers from a sequence in one atomic bump.
 *
 * Bumps `next_value` by `count` and derives the contiguous block from the
 * returned post-increment value — a bulk import of N rows costs one round-trip,
 * not N. Returns an ascending array of the allocated numbers. The sequence row
 * is created on first use, with the prefix given then.
 */
export async function allocateNumbers(db: Database, sequence: NumberSequence, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const seq = schema.taskNumberSequences;
  const [row] = await db
    .insert(seq)
    .values({
      id: generateId('seq'),
      scope: sequence.scope,
      prefix: sequence.prefix,
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
  if (!row) throw new Error(`Failed to allocate numbers for scope ${sequence.scope}`);
  // `row.nextValue` is the post-increment value; the block is the `count`
  // integers ending just below it.
  const end = row.nextValue - 1; // highest number allocated
  const start = end - count + 1; // lowest number allocated
  return Array.from({ length: count }, (_, i) => start + i);
}

/** Allocate a single number from a sequence. */
export async function allocateNumber(db: Database, sequence: NumberSequence): Promise<number> {
  const [allocated] = await allocateNumbers(db, sequence, 1);
  if (allocated === undefined) throw new Error(`Failed to allocate a number for scope ${sequence.scope}`);
  return allocated;
}

/** Allocate a single task number. */
export async function allocateTaskNumber(db: any): Promise<number> {
  return allocateNumber(db, TASK_SEQUENCE);
}

/** Allocate `count` consecutive task numbers in one atomic bump. */
export async function allocateTaskNumbers(db: any, count: number): Promise<number[]> {
  return allocateNumbers(db, TASK_SEQUENCE, count);
}
