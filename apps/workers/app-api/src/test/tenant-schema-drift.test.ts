/**
 * Guard: the Drizzle tenant schema must match the latest migration snapshot.
 *
 * `drizzle-kit generate` diffs the schema against the newest
 * `meta/<n>_snapshot.json`. Migrations added without regenerating the snapshot
 * (or schema edits without any migration) make that diff drift, until
 * `db:generate` tries to re-create dozens of existing tables — and tables that
 * were never migrated at all (WeldAgent parity, commerce portal) ship broken.
 *
 * Fix a failure here by running `pnpm --filter @weldsuite/db db:generate` and
 * committing the generated SQL, snapshot and journal entry together.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as schema from '@weldsuite/db/schema';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../../../packages/core/db/drizzle/tenant-migrations');
const metaDir = path.join(migrationsDir, 'meta');

/** Each table once — the schema re-exports some tables under a second name. */
function uniqueSchemaImports(): Record<string, unknown> {
  const seen = new Set<unknown>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    out[key] = value;
  }
  return out;
}

function latestSnapshotFile(): string {
  const files = fs.readdirSync(metaDir).filter((f) => /^\d+_snapshot\.json$/.test(f));
  files.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  return files[files.length - 1]!;
}

describe('tenant schema vs migrations', () => {
  it('has a .sql file for every journal entry, and vice versa', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(metaDir, '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const tags = journal.entries.map((e) => e.tag).sort();
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    expect(files).toEqual(tags);
  });

  it('matches the latest snapshot (run db:generate if this fails)', async () => {
    const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api') as {
      generateDrizzleJson: (imports: Record<string, unknown>, prevId?: string) => unknown;
      generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
    };
    const latest = JSON.parse(fs.readFileSync(path.join(metaDir, latestSnapshotFile()), 'utf8'));
    const current = generateDrizzleJson(uniqueSchemaImports(), latest.id);
    const pending = await generateMigration(latest, current);
    expect(pending, `schema changes without a migration:\n${pending.join('\n')}`).toEqual([]);
  }, 60_000);
});
