/**
 * Generate a master or tenant migration from the Rust entities (ADR DATA-019).
 *
 *   pnpm db:generate --name <slug>                     tenant
 *   pnpm db:generate:master --name <slug>              master
 *   pnpm db:generate --name <slug> --custom            an empty migration for hand-written SQL
 *   pnpm db:generate --name <slug> --allow-drop        allow a drop, a type change or SET NOT NULL
 *
 * (`pnpm --filter @weldsuite/db db:generate …` runs the same.)
 *
 * 1. `schema-snapshot` (rust/crates/schema) writes the snapshot the entities
 *    build: drizzle-kit's snapshot JSON, version 7.
 * 2. drizzle-kit's `generateMigration` diffs the newest journaled snapshot in
 *    rust/migrations/<database>/meta against it. drizzle-kit is the interim
 *    differ until the Rust one replaces it (plan phase 3).
 * 3. The SQL, the snapshot and the journal entry are written in drizzle-kit's
 *    layout, and all but the newest five snapshots are deleted.
 *
 * It refuses what it would otherwise have to guess or what breaks a version
 * running one migration behind (DATA-007, DATA-017):
 *   - a table, enum or view gone while another appears, or a column gone from
 *     a table that gains one: drizzle-kit would ask whether that is a rename.
 *     A rename isn't additive anyway; add, backfill and drop in steps, or write
 *     it as a --custom migration;
 *   - dropping a table, column or type, changing a column's type (widening a
 *     varchar aside) or SET NOT NULL, without --allow-drop;
 *   - CONCURRENTLY, which can't run in the migration's transaction.
 *
 * With --custom the SQL file is left for you to write, and the snapshot is the
 * entities' (drizzle-kit copies the previous one): the SQL has to bring the
 * database to what the entities say.
 *
 * Generating a migration needs a person's approval (AGENTS.md, "Data").
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_SNAPSHOTS = 5;
const BREAKPOINT = '--> statement-breakpoint\n';
const CUSTOM_SQL = '-- Custom SQL migration file, put your code below! --';

type Snapshot = Record<string, unknown> & {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
  enums: Record<string, unknown>;
  views: Record<string, unknown>;
};

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface Options {
  database: 'tenant' | 'master';
  name: string;
  custom: boolean;
  allowDrop: boolean;
}

const USAGE = 'usage: db-generate [tenant|master] --name <slug> [--custom] [--allow-drop]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseOptions(args: string[]): Options {
  const options: Partial<Options> = { database: 'tenant', custom: false, allowDrop: false };
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift() as string;
    if (arg === 'tenant' || arg === 'master') options.database = arg;
    else if (arg === '--name') options.name = rest.shift();
    else if (arg.startsWith('--name=')) options.name = arg.slice('--name='.length);
    else if (arg === '--custom') options.custom = true;
    else if (arg === '--allow-drop') options.allowDrop = true;
    else if (arg !== '--') fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (!options.name) fail(`--name is required\n${USAGE}`);
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(options.name)) {
    fail(`--name ${JSON.stringify(options.name)}: lower-case words joined by underscores`);
  }
  return options as Options;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

const pad = (idx: number): string => String(idx).padStart(4, '0');

/** Cargo from its own bin directory (rustup's proxy, which reads rust/rust-toolchain.toml). */
function cargoBinary(): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
  return path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
}

/** The snapshot the entities build, from `schema-snapshot`. */
function entitiesSnapshot(database: Options['database']): Snapshot {
  const scratch = mkdtempSync(path.join(tmpdir(), 'db-generate-'));
  const file = path.join(scratch, `${database}.json`);
  try {
    const run = spawnSync(
      cargoBinary(),
      ['run', '--quiet', '-p', 'weldsuite-schema', '--bin', 'schema-snapshot', '--', database, file],
      { cwd: path.join(repo, 'rust'), stdio: 'inherit' },
    );
    if (run.status !== 0) fail(`schema-snapshot failed (${cargoBinary()})`);
    return readJson<Snapshot>(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Keys of `next` not in `prev`, and of `prev` not in `next`. */
function addedAndGone(prev: object, next: object): { added: string[]; gone: string[] } {
  const before = new Set(Object.keys(prev));
  const after = new Set(Object.keys(next));
  return {
    added: [...after].filter((key) => !before.has(key)),
    gone: [...before].filter((key) => !after.has(key)),
  };
}

/** What drizzle-kit would ask about: something gone while something else appears. */
function ambiguities(prev: Snapshot, next: Snapshot): string[] {
  const found: string[] = [];
  for (const section of ['tables', 'enums', 'views'] as const) {
    const { added, gone } = addedAndGone(prev[section], next[section]);
    if (added.length && gone.length) {
      found.push(`${section}: ${gone.join(', ')} gone and ${added.join(', ')} new`);
    }
  }
  for (const [key, table] of Object.entries(next.tables)) {
    const before = prev.tables[key];
    if (!before) continue;
    const { added, gone } = addedAndGone(before.columns, table.columns);
    if (added.length && gone.length) {
      found.push(`${key}: columns ${gone.join(', ')} gone and ${added.join(', ')} new`);
    }
  }
  return found;
}

/** A varchar that only gets longer, or becomes text: every old value still fits. */
function widens(from: string, to: string): boolean {
  const length = (type: string): number | null => {
    const match = /^varchar(?:\((\d+)\))?$/.exec(type);
    if (!match) return null;
    return match[1] ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const before = length(from);
  if (before === null) return false;
  if (to === 'text') return true;
  const after = length(to);
  return after !== null && after >= before;
}

type Table = Snapshot['tables'][string];

/** A kept table's columns that are dropped, change type or become NOT NULL. */
function destructiveColumnChanges(key: string, before: Table, after: Table): string[] {
  const found = addedAndGone(before.columns, after.columns).gone.map((column) => `drops column ${key}.${column}`);
  for (const [name, column] of Object.entries(after.columns)) {
    const old = before.columns[name];
    if (old && old.type !== column.type && !widens(old.type, column.type)) {
      found.push(`changes the type of ${key}.${name} from ${old.type} to ${column.type}`);
    }
    if (old && !old.notNull && column.notNull) found.push(`sets ${key}.${name} NOT NULL`);
  }
  return found;
}

/** The changes that can break the previous version or lose data, by table and column. */
function destructiveChanges(prev: Snapshot, next: Snapshot): string[] {
  const found = [
    ...addedAndGone(prev.tables, next.tables).gone.map((key) => `drops table ${key}`),
    ...addedAndGone(prev.enums, next.enums).gone.map((key) => `drops type ${key}`),
  ];
  for (const [key, table] of Object.entries(next.tables)) {
    const before = prev.tables[key];
    if (before) found.push(...destructiveColumnChanges(key, before, table));
  }
  return found;
}

/** drizzle-kit's key order, so the file reads like the ones before it. */
function ordered(snapshot: Snapshot): Snapshot {
  const first = ['id', 'prevId', 'version', 'dialect', 'tables', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta'];
  const out: Record<string, unknown> = {};
  for (const key of first) if (key in snapshot) out[key] = snapshot[key];
  for (const [key, value] of Object.entries(snapshot)) if (!(key in out)) out[key] = value;
  return out as Snapshot;
}

function pruneSnapshots(meta: string): number {
  const snapshots = readdirSync(meta)
    .filter((file) => /^\d+_snapshot\.json$/.test(file))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - KEEP_SNAPSHOTS));
  for (const file of stale) rmSync(path.join(meta, file));
  return stale.length;
}

/**
 * drizzle-kit's statements from `prev` to `next`; none when a rename would
 * have to be guessed, which stops the run unless the migration is custom.
 */
async function diff(options: Options, prev: Snapshot, next: Snapshot): Promise<string[]> {
  const unclear = ambiguities(prev, next);
  if (unclear.length) {
    const message = [
      'These look like renames, which the generator never guesses:',
      ...unclear.map((line) => `  ${line}`),
      'A rename is not additive (DATA-007): add the new one, backfill, and drop the old in a later',
      'migration. To rename anyway, write it as a --custom migration.',
    ].join('\n');
    if (!options.custom) fail(message);
    console.warn(message);
    return [];
  }
  const require = createRequire(path.join(repo, 'packages', 'core', 'db', 'package.json'));
  const { generateMigration } = require('drizzle-kit/api') as {
    generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
  };
  return generateMigration(prev, next);
}

/** Stops on what a generated migration may not do (DATA-007, DATA-017). */
function refuseUnsafe(options: Options, statements: string[], prev: Snapshot, next: Snapshot): void {
  const destructive = destructiveChanges(prev, next);
  if (destructive.length && !options.allowDrop) {
    fail(
      [
        'This migration would break the version running one migration behind (DATA-007):',
        ...destructive.map((line) => `  ${line}`),
        'Ship the code that stops using it first; then rerun with --allow-drop.',
      ].join('\n'),
    );
  }
  const concurrent = statements.find((statement) => /\bCONCURRENTLY\b/i.test(statement));
  if (concurrent) fail(`CONCURRENTLY can't run in the migration's transaction (DATA-017):\n${concurrent}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dir = path.join(repo, 'rust', 'migrations', options.database);
  const meta = path.join(dir, 'meta');
  const journalFile = path.join(meta, '_journal.json');
  const journal = readJson<Journal>(journalFile);
  const last = journal.entries.at(-1);
  if (!last) fail(`${journalFile} has no entries`);
  const prev = readJson<Snapshot>(path.join(meta, `${pad(last.idx)}_snapshot.json`));
  const next = ordered({ ...entitiesSnapshot(options.database), id: randomUUID(), prevId: prev.id });
  const statements = await diff(options, prev, next);

  if (options.custom && statements.length) {
    console.warn(
      [
        `The ${options.database} entities differ from the last snapshot. The snapshot of this migration is the`,
        "entities', so its SQL has to make these changes too (drizzle-kit would write):",
        ...statements.map((statement) => `  ${statement.trim()}`),
      ].join('\n'),
    );
  } else if (!options.custom && statements.length === 0) {
    console.log(`No schema changes: the ${options.database} entities match ${pad(last.idx)}_snapshot.json.`);
    return;
  } else if (!options.custom) {
    refuseUnsafe(options, statements, prev, next);
  }

  const idx = last.idx + 1;
  const tag = `${pad(idx)}_${options.name}`;
  const sqlFile = path.join(dir, `${tag}.sql`);
  writeFileSync(sqlFile, options.custom ? CUSTOM_SQL : statements.join(BREAKPOINT));
  writeFileSync(path.join(meta, `${pad(idx)}_snapshot.json`), JSON.stringify(next, null, 2));
  journal.entries.push({ idx, version: next.version as string, when: Date.now(), tag, breakpoints: true });
  writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  const pruned = pruneSnapshots(meta);

  const count = statements.length === 1 ? '1 statement' : `${statements.length} statements`;
  const written = options.custom ? 'write its SQL' : count;
  console.log(`Wrote ${path.relative(repo, sqlFile)} (${written}), its snapshot and journal entry.`);
  if (pruned) console.log(`Deleted ${pruned} old snapshot(s), keeping ${KEEP_SNAPSHOTS}.`);
  console.log('Commit the SQL, the snapshot, the journal and the deleted snapshots together.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
