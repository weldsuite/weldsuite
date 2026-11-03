/**
 * The numbering of an entity's documents: prefix, next number and padding of
 * its invoice, credit note, bill and journal sequences
 * (`entity_number_sequences`; `nextEntityNumber` hands the numbers out).
 *
 * The next number only moves forward. Lowering it would hand out a number
 * that is already on a document, and Dutch invoices need a unique, sequential
 * series. Raising it is how a business continues the numbering of the
 * software it came from.
 */

import { and, eq, lte } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { DEFAULT_SEQUENCE_PREFIX } from '../lib/entity-context';

export const SEQUENCE_TYPES = ['invoice', 'creditNote', 'bill', 'journal'] as const;
export type SequenceType = (typeof SEQUENCE_TYPES)[number];

/** Padding of a sequence that `nextEntityNumber` creates on first use. */
const DEFAULT_PADDING = 4;

export interface NumberSequence {
  sequenceType: SequenceType;
  prefix: string;
  nextValue: number;
  padding: number;
  /** The number the next document gets, e.g. `INV-0042`. */
  nextNumber: string;
}

export interface NumberSequenceUpdate {
  sequenceType: SequenceType;
  prefix?: string;
  nextValue?: number;
  padding?: number;
}

export type SequenceChanges = Record<string, { old: unknown; new: unknown }>;

export class NumberSequenceError extends Error {
  /**
   * What was already written when the error was thrown. Empty unless a
   * document took a number mid-update; the caller still audits these.
   */
  readonly changes: SequenceChanges;

  constructor(message: string, changes: SequenceChanges = {}) {
    super(message);
    this.name = 'NumberSequenceError';
    this.changes = changes;
  }
}

export const NEXT_VALUE_FORWARD_ONLY = 'The next number can only move forward: lower numbers may already be in use';

export function formatSequenceNumber(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

type SequenceRow = typeof schema.entityNumberSequences.$inferSelect;

function toSequence(sequenceType: SequenceType, row: SequenceRow | undefined): NumberSequence {
  const prefix = row ? row.prefix : DEFAULT_SEQUENCE_PREFIX[sequenceType];
  const nextValue = row?.nextValue ?? 1;
  const padding = row ? (row.padding ?? 0) : DEFAULT_PADDING;
  return { sequenceType, prefix, nextValue, padding, nextNumber: formatSequenceNumber(prefix, nextValue, padding) };
}

/** Every sequence of the entity; one that was never used shows the values it will start with. */
export async function listNumberSequences(db: Database, entityId: string): Promise<NumberSequence[]> {
  const rows = await db
    .select()
    .from(schema.entityNumberSequences)
    .where(eq(schema.entityNumberSequences.entityId, entityId));
  return SEQUENCE_TYPES.map((type) => toSequence(type, rows.find((row) => row.sequenceType === type)));
}

/**
 * Applies the updates and returns the sequences afterwards, plus what changed
 * (for the audit log). Throws `NumberSequenceError` when a next number would
 * move backwards; every update is checked before anything is written. When a
 * document takes a number between the read and the write it throws too, with
 * the changes already written on the error.
 */
export async function updateNumberSequences(
  db: Database,
  entityId: string,
  updates: NumberSequenceUpdate[],
): Promise<{ sequences: NumberSequence[]; changes: SequenceChanges }> {
  const current = await listNumberSequences(db, entityId);

  const planned = updates.map((update) => {
    const before = current.find((s) => s.sequenceType === update.sequenceType)!;
    const next = {
      prefix: update.prefix ?? before.prefix,
      nextValue: update.nextValue ?? before.nextValue,
      padding: update.padding ?? before.padding,
    };
    if (next.nextValue < before.nextValue) throw new NumberSequenceError(NEXT_VALUE_FORWARD_ONLY);
    const changed = (['prefix', 'nextValue', 'padding'] as const).filter((field) => next[field] !== before[field]);
    return { sequenceType: update.sequenceType, before, next, changed };
  });

  const changes: SequenceChanges = {};
  for (const { sequenceType, before, next, changed } of planned) {
    if (changed.length === 0) continue;

    const now = new Date();
    const patch = Object.fromEntries(changed.map((field) => [field, next[field]]));
    const conditions = [
      eq(schema.entityNumberSequences.entityId, entityId),
      eq(schema.entityNumberSequences.sequenceType, sequenceType),
    ];
    // The forward-only guard is repeated in the WHERE clause, so a document
    // numbered between the read above and this write can't be numbered twice.
    if (changed.includes('nextValue')) conditions.push(lte(schema.entityNumberSequences.nextValue, next.nextValue));
    const [updated] = await db
      .update(schema.entityNumberSequences)
      .set({ ...patch, updatedAt: now })
      .where(and(...conditions))
      .returning({ id: schema.entityNumberSequences.id });

    if (!updated) {
      const [inserted] = await db
        .insert(schema.entityNumberSequences)
        .values({ id: generateId('seq'), entityId, sequenceType, ...next, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.entityNumberSequences.id });
      // A row exists but its next number is already past the requested one.
      if (!inserted) throw new NumberSequenceError(NEXT_VALUE_FORWARD_ONLY, changes);
    }

    for (const field of changed) {
      changes[`${sequenceType}.${field}`] = { old: before[field], new: next[field] };
    }
  }

  return { sequences: await listNumberSequences(db, entityId), changes };
}
