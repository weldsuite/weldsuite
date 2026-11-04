#!/usr/bin/env node
/**
 * Deletes all but the newest KEEP Drizzle snapshots in each migration folder.
 *
 * drizzle-kit writes a full copy of the schema (`meta/<n>_snapshot.json`,
 * ~2 MB for the tenant schema) on every `db:generate`, and only ever reads the
 * newest one back: it is the "before" side of the next diff. The migration
 * runners (apps/tools/migrate-databases, workspace-worker, the Rust
 * migrations crate, the pglite test harness) read the SQL files and
 * `_journal.json`, never a snapshot, and the drift test compares the schema
 * with the newest. Kept, the old ones were half of every checkout and
 * worktree. Git history still has them all.
 *
 * KEEP is more than one so `drizzle-kit drop` can still take back the last
 * few migrations: dropping one makes the snapshot before it the newest.
 *
 * Runs after every db:generate script; on its own: `pnpm --filter @weldsuite/db db:prune-snapshots`.
 */
/* global console */
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = 5;
const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

for (const folder of readdirSync(drizzleDir, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const metaDir = path.join(drizzleDir, folder.name, 'meta');
  let files;
  try {
    files = readdirSync(metaDir);
  } catch {
    continue;
  }
  const snapshots = files
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - KEEP));
  for (const file of stale) rmSync(path.join(metaDir, file));
  if (stale.length) console.log(`${folder.name}: removed ${stale.length} old snapshots, kept ${KEEP}`);
}
