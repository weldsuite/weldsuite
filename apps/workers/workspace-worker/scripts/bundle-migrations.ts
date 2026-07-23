/**
 * Bundle Tenant Migrations for Cloudflare Workers
 *
 * Reads all Drizzle migration SQL files and the journal from
 * packages/core/db/drizzle/tenant-migrations/ and outputs a TypeScript
 * module with embedded SQL strings + pre-computed SHA-256 hashes.
 *
 * Run: pnpm bundle-migrations
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../packages/core/db/drizzle/tenant-migrations');
const OUTPUT_FILE = path.resolve(__dirname, '../src/generated/tenant-migrations.ts');

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
  console.log(`Found ${journal.entries.length} migrations in journal`);

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
    const escapedSql = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    sqlEntries.push(`  ${JSON.stringify(entry.tag)}: \`${escapedSql}\``);
    hashEntries.push(`  ${JSON.stringify(entry.tag)}: ${JSON.stringify(hash)}`);
  }

  const output = `/**
 * AUTO-GENERATED — do not edit manually.
 * Run \`pnpm bundle-migrations\` to regenerate.
 *
 * Contains ${journal.entries.length} tenant database migrations bundled for Cloudflare Workers.
 * Generated from: packages/core/db/drizzle/tenant-migrations/
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
