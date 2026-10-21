/** Typed errors of the move engine. Each carries enough to name the culprit and none carries row data. */

import type { JournalSummary } from './types';

export class DatabaseMoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

function describeJournal(journal: JournalSummary | null): string {
  if (!journal) return 'has no journal';
  return `${journal.count} entries, newest created_at ${journal.maxCreatedAt ?? 'none'}`;
}

/** Source and target were migrated to different points: copying would produce a broken database. */
export class JournalMismatchError extends DatabaseMoveError {
  constructor(
    readonly source: JournalSummary | null,
    readonly target: JournalSummary | null,
  ) {
    super(
      'JOURNAL_MISMATCH',
      `Migration journals differ: source ${describeJournal(source)}, target ${describeJournal(target)}`,
    );
  }
}

/** The target lacks tables or columns the source has, although the journals matched. */
export class SchemaMismatchError extends DatabaseMoveError {
  constructor(
    readonly missingTables: string[],
    readonly missingColumns: Array<{ table: string; column: string }>,
  ) {
    super(
      'SCHEMA_MISMATCH',
      `Target schema is missing ${missingTables.length} table(s) and ${missingColumns.length} column(s) of the source` +
        (missingTables.length ? `; tables: ${missingTables.slice(0, 10).join(', ')}` : '') +
        (missingColumns.length
          ? `; columns: ${missingColumns
              .slice(0, 10)
              .map((c) => `${c.table}.${c.column}`)
              .join(', ')}`
          : ''),
    );
  }
}

/**
 * The schema uses something the copy cannot carry over safely (today: sequences,
 * whose counters would restart from 1 on the target and collide with copied rows).
 */
export class UnsupportedSchemaError extends DatabaseMoveError {
  constructor(
    readonly feature: string,
    readonly objects: string[],
  ) {
    super(
      'UNSUPPORTED_SCHEMA',
      `The schema has ${feature} the move engine does not copy: ${objects.slice(0, 10).join(', ')}`,
    );
  }
}

/** A foreign key does not hold on the copied data (or could not be re-added). */
export class ForeignKeyValidationError extends DatabaseMoveError {
  constructor(
    readonly table: string,
    readonly constraint: string,
    cause: unknown,
  ) {
    super(
      'FOREIGN_KEY_VALIDATION_FAILED',
      `Foreign key "${constraint}" on table "${table}" failed validation after the copy`,
      { cause },
    );
  }
}

export class TableWithoutPrimaryKeyError extends DatabaseMoveError {
  constructor(readonly table: string) {
    super('TABLE_WITHOUT_PRIMARY_KEY', `Table "${table}" has no primary key, so it cannot be copied in pages`);
  }
}

export class InvalidCursorError extends DatabaseMoveError {
  constructor(readonly table: string) {
    super('INVALID_CURSOR', `Cursor for table "${table}" does not match its primary key`);
  }
}

/** A guard step did not take effect (e.g. sessions survived `pg_terminate_backend`). */
export class GuardError extends DatabaseMoveError {
  constructor(message: string) {
    super('GUARD_FAILED', message);
  }
}
