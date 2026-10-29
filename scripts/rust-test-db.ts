/**
 * Build a master and a tenant database from the journaled Drizzle migrations
 * (packages/core/db/drizzle/{master,tenant}-migrations), for the Rust tests
 * that check their SQL against the real schema and for the kind smoke test.
 *
 *   tsx scripts/rust-test-db.ts --master postgres://… --tenant postgres://…
 *
 * Applies exactly what the migration runner applies: the journal's entries,
 * in order. Like the pglite test helper (worker-kit/src/testing/pglite.ts) it
 * tolerates "already exists" / "does not exist" on statements the history
 * repeats. The tenant schema needs the pgvector and pg_trgm extensions, so use
 * the `pgvector/pgvector` Postgres image.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = path.join(repo, 'packages', 'core', 'db', 'drizzle');

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function migrate(url: string, folder: 'master-migrations' | 'tenant-migrations'): Promise<number> {
  const dir = path.join(migrationsRoot, folder);
  const journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let applied = 0;
  try {
    for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const raw = readFileSync(path.join(dir, `${entry.tag}.sql`), 'utf8');
      const statements = raw
        .split(/-->\s*statement-breakpoint/)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        try {
          await sql.unsafe(statement);
        } catch (error) {
          const message = (error as Error).message;
          if (/already exists|does not exist/i.test(message)) continue;
          throw new Error(`${folder}/${entry.tag}: ${message}\n${statement.slice(0, 200)}`);
        }
      }
      applied++;
    }
  } finally {
    await sql.end();
  }
  return applied;
}

async function main(): Promise<void> {
  const master = argument('master');
  const tenant = argument('tenant');
  if (!master && !tenant) {
    console.error('usage: tsx scripts/rust-test-db.ts --master <url> --tenant <url>');
    process.exit(2);
  }
  if (master) console.log(`master: ${await migrate(master, 'master-migrations')} migrations`);
  if (tenant) console.log(`tenant: ${await migrate(tenant, 'tenant-migrations')} migrations`);
}

void main();
