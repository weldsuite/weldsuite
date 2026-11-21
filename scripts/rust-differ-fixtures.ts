/**
 * The goldens of the Rust migration differ (ADR DATA-019, plan phase 3): what
 * drizzle-kit wrote for every pair of consecutive master and tenant snapshots
 * in git history.
 *
 *   pnpm exec tsx scripts/rust-differ-fixtures.ts
 *
 * For each pair (n-1, n) whose snapshots git still has, drizzle-kit 0.30's
 * Postgres differ runs on them and the statements are written, with both
 * snapshots cut down to the objects that changed, to
 * rust/crates/schema/tests/differ/<database>/<n>.json.gz. The Rust differ must
 * write the same statements (`cargo test -p weldsuite-schema --test differ`).
 *
 * drizzle-kit asks on a terminal whether a table or column that disappears
 * while another appears was renamed. Its snapshot records the answer
 * (`_meta`), so the differ is called with resolvers that give that answer
 * instead: its bundle is loaded with the internal differ exposed.
 *
 * A one-off: the goldens stay when drizzle-kit leaves the repository.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(repo, 'rust', 'crates', 'schema', 'tests', 'differ');

type Json = Record<string, unknown>;
type Named = { name: string; schema?: string } & Json;
interface Snapshot extends Json {
  id: string;
  prevId: string;
  tables: Record<string, Json>;
  enums: Record<string, Json>;
  views: Record<string, Json>;
  _meta?: { tables?: Record<string, string>; columns?: Record<string, string> };
}

interface DrizzleInternals {
  applyPgSnapshotsDiff: (...args: unknown[]) => Promise<{ sqlStatements: string[] }>;
  pgSchema: { parse: (value: unknown) => unknown };
  squashPgScheme: (value: unknown) => unknown;
}

/** drizzle-kit's API bundle with its Postgres differ exposed. */
function drizzleInternals(): DrizzleInternals {
  const require = createRequire(path.join(repo, 'packages', 'core', 'db', 'package.json'));
  const file = require.resolve('drizzle-kit/api');
  const source = `${readFileSync(file, 'utf8')}
module.exports.__internals = {
  applyPgSnapshotsDiff: (...args) => (init_snapshotsDiffer(), snapshotsDiffer_exports).applyPgSnapshotsDiff(...args),
  pgSchema,
  squashPgScheme,
};`;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = (Module as unknown as { _nodeModulePaths: (dir: string) => string[] })._nodeModulePaths(path.dirname(file));
  (mod as unknown as { _compile: (code: string, filename: string) => void })._compile(source, file);
  return (mod.exports as { __internals: DrizzleInternals }).__internals;
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 30, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Every snapshot number of a database that main's history has, with its path. */
function snapshotFiles(database: string): Map<number, string> {
  const dirs = [`packages/core/db/drizzle/${database}-migrations/meta`, `rust/migrations/${database}/meta`];
  const files = new Map<number, string>();
  for (const dir of dirs) {
    const names = git(['log', '--full-history', 'origin/main', '--diff-filter=A', '--name-only', '--format=', '--', `${dir}/*_snapshot.json`])
      .split('\n')
      .filter(Boolean);
    for (const name of names) {
      const n = Number.parseInt(path.basename(name), 10);
      if (!files.has(n)) files.set(n, name);
    }
  }
  return files;
}

/** The newest version of a snapshot that main's history has. */
function snapshotAt(file: string): Snapshot {
  for (const commit of git(['log', '--full-history', '--format=%H', 'origin/main', '--', file]).split('\n').filter(Boolean)) {
    try {
      return JSON.parse(git(['show', `${commit}:${file}`])) as Snapshot;
    } catch {
      // deleted in that commit: try the one before
    }
  }
  throw new Error(`no version of ${file} in main's history`);
}

/** `"public"."name"` → `public.name`, the snapshot's key. */
const metaKey = (quoted: string): string => quoted.replaceAll('"', '');

/** Resolvers that answer drizzle-kit's rename questions from the new snapshot's `_meta`. */
function resolvers(next: Snapshot) {
  const tableRenames = new Map(Object.entries(next._meta?.tables ?? {}).map(([from, to]) => [metaKey(from), metaKey(to)]));
  const columnRenames = new Map(Object.entries(next._meta?.columns ?? {}).map(([from, to]) => [metaKey(from), metaKey(to)]));
  const key = (item: Named) => `${item.schema || 'public'}.${item.name}`;

  function pair<T extends Named>(created: T[], deleted: T[], renames: Map<string, string>) {
    const renamed: Array<{ from: T; to: T }> = [];
    let left = [...created];
    const gone: T[] = [];
    for (const item of deleted) {
      const to = renames.get(key(item));
      const target = to ? left.find((candidate) => key(candidate) === to) : undefined;
      if (target) {
        renamed.push({ from: item, to: target });
        left = left.filter((candidate) => candidate !== target);
      } else {
        gone.push(item);
      }
    }
    return { created: left, deleted: gone, renamed };
  }

  // drizzle-kit awaits its resolvers; these answer at once.
  const named = (input: { created: Named[]; deleted: Named[] }) =>
    Promise.resolve({ ...pair(input.created, input.deleted, tableRenames), moved: [] });
  const plain = (input: { created: Named[]; deleted: Named[] }) =>
    Promise.resolve({ created: input.created, deleted: input.deleted, renamed: [] });
  const unrenamed = (input: { created: Named[]; deleted: Named[] }) =>
    Promise.resolve({ created: input.created, deleted: input.deleted, moved: [], renamed: [] });
  const columns = (input: { tableName: string; schema: string; created: Named[]; deleted: Named[] }) => {
    const prefix = `${input.schema || 'public'}.${input.tableName}.`;
    const renames = new Map([...columnRenames].filter(([from]) => from.startsWith(prefix)).map(([from, to]) => [from.slice(prefix.length), to.slice(prefix.length)]));
    const renamed: Array<{ from: Named; to: Named }> = [];
    let left = [...input.created];
    const gone: Named[] = [];
    for (const item of input.deleted) {
      const target = left.find((candidate) => candidate.name === renames.get(item.name));
      if (target) {
        renamed.push({ from: item, to: target });
        left = left.filter((candidate) => candidate !== target);
      } else {
        gone.push(item);
      }
    }
    return Promise.resolve({ tableName: input.tableName, schema: input.schema, created: left, deleted: gone, renamed });
  };
  const policies = (input: { tableName: string; schema: string; created: Named[]; deleted: Named[] }) =>
    Promise.resolve({
      tableName: input.tableName,
      schema: input.schema,
      created: input.created,
      deleted: input.deleted,
      renamed: [],
    });
  // schemas, enums, sequences, policy, indPolicy, roles, tables, columns, views
  return [plain, unrenamed, unrenamed, policies, plain, plain, named, columns, unrenamed];
}

/** The pair cut down to the tables, enums and views that differ (renamed ones under both names). */
function changedOnly(prev: Snapshot, next: Snapshot): [Snapshot, Snapshot] {
  const renamedTables = new Set(Object.entries(next._meta?.tables ?? {}).flatMap(([from, to]) => [metaKey(from), metaKey(to)]));
  const cut = (section: 'tables' | 'enums' | 'views') => {
    const keys = new Set([...Object.keys(prev[section]), ...Object.keys(next[section])]);
    const keep = [...keys].filter(
      (key) => JSON.stringify(prev[section][key]) !== JSON.stringify(next[section][key]) || renamedTables.has(key),
    );
    const pick = (snapshot: Snapshot) => Object.fromEntries(keep.filter((key) => key in snapshot[section]).map((key) => [key, snapshot[section][key]]));
    return [pick(prev), pick(next)];
  };
  const [tablesA, tablesB] = cut('tables');
  const [enumsA, enumsB] = cut('enums');
  const [viewsA, viewsB] = cut('views');
  return [
    { ...prev, tables: tablesA, enums: enumsA, views: viewsA },
    { ...next, tables: tablesB, enums: enumsB, views: viewsB },
  ];
}

async function statements(drizzle: DrizzleInternals, prev: Snapshot, next: Snapshot): Promise<string[]> {
  const validPrev = drizzle.pgSchema.parse(prev);
  const validNext = drizzle.pgSchema.parse(next);
  const { sqlStatements } = await drizzle.applyPgSnapshotsDiff(
    drizzle.squashPgScheme(validPrev),
    drizzle.squashPgScheme(validNext),
    ...resolvers(next),
    validPrev,
    validNext,
  );
  return sqlStatements;
}

/** Writes the golden of one pair, after checking the cut-down snapshots give drizzle-kit's statements. */
async function writePair(drizzle: DrizzleInternals, database: string, n: number, prev: Snapshot, next: Snapshot): Promise<void> {
  const full = await statements(drizzle, prev, next);
  const [cutPrev, cutNext] = changedOnly(prev, next);
  const cut = await statements(drizzle, cutPrev, cutNext);
  if (JSON.stringify(full) !== JSON.stringify(cut)) {
    throw new Error(`${database} ${n}: cutting the snapshots down changed drizzle-kit's statements`);
  }
  const renames = { tables: next._meta?.tables ?? {}, columns: next._meta?.columns ?? {} };
  const fixture = { database, n, renames, prev: cutPrev, next: cutNext, statements: full };
  const file = path.join(OUT, database, `${String(n).padStart(4, '0')}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(fixture), { level: 9 }));
}

interface Progress {
  written: number;
  skipped: string[];
}

/**
 * Pairs `numbers[i]` with the snapshot before it, then goes on to the next
 * number: one pair at a time, so only two snapshots (2 MB each) are loaded.
 */
async function walk(
  drizzle: DrizzleInternals,
  database: string,
  files: Map<number, string>,
  numbers: number[],
  i: number,
  prev: { n: number; snapshot: Snapshot } | null,
  progress: Progress,
): Promise<Progress> {
  if (i >= numbers.length) return progress;
  const n = numbers[i];
  const next = snapshotAt(files.get(n) as string);
  if (prev && prev.n === n - 1 && next.prevId === prev.snapshot.id) {
    await writePair(drizzle, database, n, prev.snapshot, next);
    progress.written++;
  } else if (prev) {
    const why = prev.n === n - 1 ? 'prevId does not chain' : `no snapshot ${n - 1}`;
    progress.skipped.push(`${database} ${n} (${why})`);
  }
  return walk(drizzle, database, files, numbers, i + 1, { n, snapshot: next }, progress);
}

/** The goldens of one database; the snapshot numbers that couldn't be paired. */
function writeDatabase(drizzle: DrizzleInternals, database: string): Promise<Progress> {
  mkdirSync(path.join(OUT, database), { recursive: true });
  const files = snapshotFiles(database);
  const numbers = [...files.keys()].sort((a, b) => a - b);
  return walk(drizzle, database, files, numbers, 0, null, { written: 0, skipped: [] });
}

async function main(): Promise<void> {
  const drizzle = drizzleInternals();
  rmSync(OUT, { recursive: true, force: true });
  const tenant = await writeDatabase(drizzle, 'tenant');
  const master = await writeDatabase(drizzle, 'master');
  const written = tenant.written + master.written;
  const skipped = [...tenant.skipped, ...master.skipped];
  console.log(`${written} pairs written to ${path.relative(repo, OUT)}`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
