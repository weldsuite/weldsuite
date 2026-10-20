/**
 * Which tenant migrations a database has applied, read from its
 * `__drizzle_migrations` rows, against the tenant journal
 * (`drizzle/tenant-migrations/meta/_journal.json`). Pure: callers read the rows
 * and build the journal entries themselves (the worker from its bundle, the
 * migration tool from disk).
 *
 * Two runners write those rows, so a row identifies its migration in one of
 * three ways:
 *  - `tag`: written by the workspace worker's applier (`applyTenantMigrations`);
 *  - `hash`: drizzle's migrator (`apps/tools/migrate-databases`) writes the
 *    sha256 of the migration file, but no tag;
 *  - `created_at`: drizzle writes the entry's `when`; this is the only match left
 *    when the file was edited after it was applied (the hash then differs).
 *
 * drizzle's migrator applies only migrations NEWER than the newest row, so a
 * migration merged with an older timestamp is skipped for good on databases
 * that already ran a later one. Comparing by count and newest row hides that;
 * comparing the set of migrations shows it as `missing`.
 */

export interface TenantJournalEntry {
  tag: string;
  /** The journal's `when`, which drizzle stores as `created_at`. */
  when: number;
  /** sha256 (hex) of the migration file as it is now. */
  hash: string;
}

/** One `__drizzle_migrations` row. `tag` is null when drizzle's migrator wrote it (or the column does not exist). */
export interface RecordedMigration {
  tag: string | null;
  hash: string | null;
  /** `created_at` as text (a bigint). */
  createdAt: string | null;
}

/**
 * Rows of migrations that are not, or no longer, in the journal, and whose
 * changes the journal already holds: they count as nothing. Checked against the
 * schema of every test tenant before being listed here (task 1150).
 */
export const RETIRED_MIGRATION_HASHES: ReadonlyMap<string, string> = new Map([
  [
    '3844944a8c61a86607b981f47886e4fc09bc8249c635614727ba433754a13ed4',
    'applied on 2026-04-16 from a branch that was never merged',
  ],
  [
    '2061c8f2a3273ecb7dcd1d14fcf203cd2984060154218cb233e7cbee597806ea',
    'applied on 2026-04-16 from a branch that was never merged',
  ],
]);

/**
 * Earlier versions of a journal migration, recorded under another hash and
 * `created_at`, whose changes equal the current version's: a row with one of
 * these hashes counts as that migration.
 */
export const SUPERSEDED_MIGRATION_HASHES: ReadonlyMap<string, string> = new Map([
  // The 2026-08-20 version of 0124 (commit 0b3d0fb19); its `when` was 1777662354345 then.
  ['25a06a163f4b21c4563468a803b99db0b8928dc371baef647400c5fc158d1d7c', '0124_massive_natasha_romanoff'],
]);

export interface TenantJournalMatch {
  /** Journal tags the database has applied. */
  applied: Set<string>;
  /** Journal entries it has not applied, in journal order. */
  missing: TenantJournalEntry[];
  /** Rows that match no journal entry and are not retired: a migration this journal does not know. */
  unknown: RecordedMigration[];
  /** Rows that repeat a migration another row already recorded (harmless). */
  duplicates: number;
}

/** The journal tag a row records, `null` for a retired row, `undefined` for a row nothing explains. */
function tagOf(
  row: RecordedMigration,
  byTag: ReadonlySet<string>,
  byHash: ReadonlyMap<string, string>,
  byWhen: ReadonlyMap<string, string>,
): string | null | undefined {
  if (row.tag && byTag.has(row.tag)) return row.tag;
  if (row.hash) {
    const tag = byHash.get(row.hash) ?? SUPERSEDED_MIGRATION_HASHES.get(row.hash);
    if (tag && byTag.has(tag)) return tag;
    if (RETIRED_MIGRATION_HASHES.has(row.hash)) return null;
  }
  if (row.createdAt !== null) return byWhen.get(row.createdAt);
  return undefined;
}

export function matchTenantJournal(
  rows: readonly RecordedMigration[],
  journal: readonly TenantJournalEntry[],
): TenantJournalMatch {
  const byTag = new Set(journal.map((entry) => entry.tag));
  const byHash = new Map(journal.map((entry) => [entry.hash, entry.tag]));
  const byWhen = new Map(journal.map((entry) => [String(entry.when), entry.tag]));

  const applied = new Set<string>();
  const unknown: RecordedMigration[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const tag = tagOf(row, byTag, byHash, byWhen);
    if (tag === null) continue;
    if (tag === undefined) {
      unknown.push(row);
    } else if (applied.has(tag)) {
      duplicates++;
    } else {
      applied.add(tag);
    }
  }
  return { applied, missing: journal.filter((entry) => !applied.has(entry.tag)), unknown, duplicates };
}

/** Every journal migration applied, and nothing the journal does not know. */
export function isAtJournalLevel(match: Pick<TenantJournalMatch, 'missing' | 'unknown'>): boolean {
  return match.missing.length === 0 && match.unknown.length === 0;
}

/** One line for logs and errors: what is missing (first few tags) and how many rows are unknown. */
export function describeJournalGap(match: Pick<TenantJournalMatch, 'missing' | 'unknown'>, show = 3): string {
  const parts: string[] = [];
  if (match.missing.length > 0) {
    const first = match.missing.slice(0, show).map((entry) => entry.tag);
    const more = match.missing.length > show ? `, +${match.missing.length - show} more` : '';
    parts.push(`${match.missing.length} migration(s) missing (${first.join(', ')}${more})`);
  }
  if (match.unknown.length > 0) parts.push(`${match.unknown.length} row(s) of migrations the journal does not know`);
  return parts.length > 0 ? parts.join('; ') : 'at the journal level';
}
