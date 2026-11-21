/**
 * Bundle Tenant Migrations for Cloudflare Workers
 *
 * Reads the tenant migration SQL files and the journal from
 * rust/migrations/tenant/ and outputs a TypeScript module with embedded SQL
 * strings + pre-computed SHA-256 hashes.
 *
 * Only up to the last migration drizzle-kit generated: after it the
 * migrations come from the Rust entities (ADR DATA-019), Global's databases
 * stay at that level (its deploy no longer migrates them), and so do the
 * tenant databases this worker provisions.
 *
 * Run: pnpm bundle-migrations
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../rust/migrations/tenant');
const OUTPUT_FILE = path.resolve(__dirname, '../src/generated/tenant-migrations.ts');
const LAST_DRIZZLE_MIGRATION = '0256_weldstash_replenishment';

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

function main() {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta/_journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`Journal not found: ${journalPath}`);
    process.exit(1);
  }

  const journal: Journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_DRIZZLE_MIGRATION);
  if (last < 0) {
    console.error(`${LAST_DRIZZLE_MIGRATION} is not in ${journalPath}`);
    process.exit(1);
  }
  journal.entries = journal.entries.slice(0, last + 1);
  console.log(`Bundling ${journal.entries.length} migrations, up to ${LAST_DRIZZLE_MIGRATION}`);

  const journalEntries: string[] = [];
  const sqlEntries: string[] = [];
  const hashEntries: string[] = [];

  for (const entry of journal.entries) {
    const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      console.error(`Migration SQL file not found: ${sqlPath}`);
      process.exit(1);
    }

    const sql = fs.readFileSync(sqlPath, 'utf-8').trim();
    // Keep `--> statement-breakpoint` markers — the runtime splits on them
    // to handle PL/pgSQL blocks (DO $$ ... $$) safely under Neon HTTP, which
    // rejects multi-statement queries.

    const hash = crypto.createHash('sha256').update(sql).digest('hex');

    journalEntries.push(`  { idx: ${entry.idx}, tag: ${JSON.stringify(entry.tag)}, when: ${entry.when} }`);
    // Use backtick-escaped template literal for SQL (escape backticks and ${)
    const escapedSql = sql.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
    sqlEntries.push(`  ${JSON.stringify(entry.tag)}: \`${escapedSql}\``);
    hashEntries.push(`  ${JSON.stringify(entry.tag)}: ${JSON.stringify(hash)}`);
  }

  const output = `/**
 * AUTO-GENERATED — do not edit manually.
 * Run \`pnpm bundle-migrations\` to regenerate.
 *
 * Contains ${journal.entries.length} tenant database migrations bundled for Cloudflare Workers.
 * Generated from: rust/migrations/tenant/, up to ${LAST_DRIZZLE_MIGRATION}
 */

export const MIGRATION_JOURNAL = [
${journalEntries.join(',\n')},
] as const;

export const MIGRATION_SQL: Record<string, string> = {
${sqlEntries.join(',\n')},
};

export const MIGRATION_HASHES: Record<string, string> = {
${hashEntries.join(',\n')},
};
`;

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');
  console.log(`Bundled ${journal.entries.length} migrations to ${OUTPUT_FILE}`);
}

main();
