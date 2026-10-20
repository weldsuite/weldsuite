#!/usr/bin/env node

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { describeJournalGap, isAtJournalLevel } from '@weldsuite/db/lib/tenant-journal';
import { partitionByActiveMove, workspacesWithActiveMove } from './lib/active-moves';
import { applySkippedMigrations, checkJournal, loadTenantJournal, type TenantJournal } from './lib/journal-gap';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Get current directory for resolving migration path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI argument parsing
interface CliOptions {
  dryRun: boolean;
  only: string | null;
  verbose: boolean;
  redact: boolean;
  /** Also apply journal migrations drizzle's migrator skipped (merged with an older timestamp). */
  applySkipped: boolean;
  /** Only report each workspace's journal gap; changes nothing. */
  checkJournal: boolean;
}

// The repo is public, so CI logs are world-readable. Tenant identities stay out
// of the output unless someone opts in locally.
function redactByDefault(): boolean {
  return process.env.CI === 'true' || Boolean(process.env.GITHUB_ACTIONS);
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    dryRun: false,
    only: null,
    verbose: false,
    redact: redactByDefault(),
    applySkipped: false,
    checkJournal: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--only' && args[i + 1]) {
      options.only = args[++i] ?? null;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--redact') {
      options.redact = true;
    } else if (arg === '--show-workspaces') {
      options.redact = false;
    } else if (arg === '--apply-skipped') {
      options.applySkipped = true;
    } else if (arg === '--check-journal') {
      options.checkJournal = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Multi-Tenant Database Migration Tool

Usage:
  pnpm migrate [options]

Options:
  --dry-run          List all workspaces without running migrations
  --only <id>        Migrate only a specific workspace by ID (Clerk org ID)
  --verbose          Show detailed migration output
  --redact           Hide workspace names, IDs and database hosts
  --show-workspaces  Show workspace details (overrides --redact)
  --check-journal    Only report, per workspace, journal migrations it has not
                     applied (connects to every tenant; changes nothing)
  --apply-skipped    After migrating, also apply journal migrations drizzle
                     skipped because they were merged with an older timestamp
  --help, -h         Show this help message

Workspace details are redacted by default in CI (CI / GITHUB_ACTIONS set) so
tenant identities never land in public workflow logs. Pass --show-workspaces
when running locally to see them.

A workspace whose database is being moved to another Neon project or shard
(workspace_database_moves, status queued ... switching or cancelling) is
skipped, not failed: its old database is locked read-only on purpose. It is
migrated by the next run, wherever it lives by then.

drizzle's migrator applies only migrations newer than the newest one a database
has recorded, so a migration merged with an older timestamp is skipped for good.
After migrating, every workspace is checked migration by migration against the
journal; a gap is reported as a warning (never a failure). --apply-skipped
applies the missing migrations, each in its own transaction.

Examples:
  pnpm migrate                    # Run migrations on all workspace databases
  pnpm migrate:dry-run            # List all workspaces and their databases
  pnpm migrate -- --only org_123  # Migrate only workspace org_123
  pnpm migrate -- --verbose       # Run with detailed output
  pnpm migrate -- --check-journal # Report skipped migrations, change nothing
  pnpm migrate -- --apply-skipped # Migrate, then apply skipped migrations
`);
}

interface WorkspaceInfo {
  id: string;
  name: string;
  databaseUrl: string;
  neonProjectId: string;
}

interface MigrationResult {
  workspaceId: string;
  workspaceName: string;
  success: boolean;
  error?: string;
  /** Journal migrations still not applied after this run (one line), when any. */
  journalGap?: string;
  /** Skipped migrations this run applied (with --apply-skipped). */
  appliedSkipped?: string[];
}

/** A workspace left out of the run because a database move owns its database right now. */
interface SkippedWorkspace {
  id: string;
  name: string;
}

// Set once from CLI options, consulted by the logging helpers below.
let redactWorkspaces = redactByDefault();

// Anonymous positional label used in place of name/ID when redacting.
function workspaceLabel(index: number, name: string, id: string): string {
  return redactWorkspaces ? `workspace #${index}` : `${name} (${id})`;
}

// Driver errors routinely quote the connection string or the Neon host, so
// scrub anything identifying before it reaches the log.
function sanitizeMessage(message: string): string {
  if (!redactWorkspaces) return message;
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-connection-string>')
    .replace(/\b[\w.-]+\.neon\.tech\b/gi, '<redacted-host>')
    .replace(/\borg_[A-Za-z0-9]+/g, '<redacted-workspace-id>');
}

async function getWorkspaces(
  masterClient: postgres.Sql,
  only: string | null,
): Promise<{ workspaces: WorkspaceInfo[]; skipped: SkippedWorkspace[] }> {
  const db = drizzle(masterClient);

  const neonApiKey = process.env.NEON_API_KEY || '';
  const encryptionKey = {
    v1: process.env.DATABASE_ENCRYPTION_KEY,
    v2: process.env.DATABASE_ENCRYPTION_KEY_V2,
  };

  const conditions = [
    eq(workspaces.isActive, true),
    isNotNull(workspaces.neonProjectId),
  ];

  if (only) {
    conditions.push(eq(workspaces.id, only));
  }

  const result = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      neonProjectId: workspaces.neonProjectId,
      neonBranchId: workspaces.neonBranchId,
      neonRoleName: workspaces.neonRoleName,
      neonDatabaseName: workspaces.neonDatabaseName,
      databaseUrl: workspaces.databaseUrl,
    })
    .from(workspaces)
    .where(and(...conditions));

  // A workspace whose database is being moved is left out before its URL is resolved: its old database is
  // locked read-only on purpose, and the move migrates the target itself.
  const { migratable, skipped } = partitionByActiveMove(
    result,
    await workspacesWithActiveMove(db, result.map((w) => w.id)),
  );

  // Resolve connection URIs — uses stored databaseUrl when available,
  // falls back to Neon API only if needed
  const resolved: WorkspaceInfo[] = [];
  for (const w of migratable) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    const databaseUrl = await resolveDatabaseUrl(neonApiKey, w as any, encryptionKey);
    resolved.push({ id: w.id, name: w.name, databaseUrl, neonProjectId: w.neonProjectId });
  }

  return { workspaces: resolved, skipped: skipped.map((w) => ({ id: w.id, name: w.name })) };
}

interface MigrateWorkspaceOptions {
  verbose: boolean;
  journal: TenantJournal;
  applySkipped: boolean;
  /** Run nothing: only report the journal gap. */
  checkOnly: boolean;
}

/** A connection to the workspace's tenant database (SSL: Neon requires it). */
function connectTenant(workspace: WorkspaceInfo, verbose: boolean): postgres.Sql {
  if (verbose) {
    console.log(`  Connecting to database...`);
  }
  return postgres(workspace.databaseUrl, {
    max: 1,
    onnotice: verbose ? (msg) => console.log(`  Notice: ${sanitizeMessage(msg.message)}`) : () => {},
  });
}

async function runDrizzleMigrations(client: postgres.Sql, migrationsFolder: string, verbose: boolean): Promise<void> {
  if (verbose) {
    console.log(`  Running migrations from: ${migrationsFolder}`);
  }
  await migrate(drizzle(client), { migrationsFolder, migrationsSchema: 'public' });
}

/**
 * drizzle only applies migrations newer than the newest one recorded: what is
 * still missing after it ran, after applying it first when asked to.
 */
async function reconcileJournal(
  client: postgres.Sql,
  options: MigrateWorkspaceOptions,
): Promise<Pick<MigrationResult, 'journalGap' | 'appliedSkipped'>> {
  const result: Pick<MigrationResult, 'journalGap' | 'appliedSkipped'> = {};
  let match = await checkJournal(client, options.journal);
  if (options.applySkipped && !options.checkOnly && match.missing.length > 0) {
    result.appliedSkipped = await applySkippedMigrations(client, options.journal, match);
    match = await checkJournal(client, options.journal);
  }
  if (!isAtJournalLevel(match)) {
    result.journalGap = describeJournalGap(match);
  }
  return result;
}

async function migrateWorkspace(
  workspace: WorkspaceInfo,
  migrationsFolder: string,
  options: MigrateWorkspaceOptions,
): Promise<MigrationResult> {
  const identity = { workspaceId: workspace.id, workspaceName: workspace.name };
  let client: postgres.Sql | null = null;

  try {
    client = connectTenant(workspace, options.verbose);
    if (!options.checkOnly) {
      await runDrizzleMigrations(client, migrationsFolder, options.verbose);
    }
    return { ...identity, success: true, ...(await reconcileJournal(client, options)) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { ...identity, success: false, error: sanitizeMessage(errorMessage) };
  } finally {
    await client?.end();
  }
}

function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '****';
    return parsed.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':****@');
  }
}

function printNoWorkspacesFound(only: string | null): void {
  if (!only) {
    console.log('No active workspaces with database URLs found.');
    return;
  }
  console.log(
    redactWorkspaces
      ? 'No active workspace found with the requested ID.'
      : `No active workspace found with ID: ${only}`
  );
}

// Names only when not redacting; the databases are never shown (the move row holds them).
function printSkippedWorkspaces(skipped: SkippedWorkspace[]): void {
  if (skipped.length === 0) return;
  console.log(`Skipping ${skipped.length} workspace(s): a database move is in progress (not a failure):`);
  skipped.forEach((workspace, index) => {
    console.log(
      redactWorkspaces
        ? `  skipped workspace #${index + 1}`
        : `  ${workspace.name} (${workspace.id})`
    );
  });
  console.log('');
}

function printWorkspaceList(workspaceList: WorkspaceInfo[]): void {
  let listIndex = 0;
  for (const workspace of workspaceList) {
    listIndex++;
    if (redactWorkspaces) {
      console.log(`  ${workspaceLabel(listIndex, workspace.name, workspace.id)}`);
    } else {
      console.log(`  ID:   ${workspace.id}`);
      console.log(`  Name: ${workspace.name}`);
      console.log(`  DB:   ${maskDatabaseUrl(workspace.databaseUrl)}`);
    }
    console.log('');
  }
}

async function runMigrations(
  workspaceList: WorkspaceInfo[],
  migrationsFolder: string,
  options: MigrateWorkspaceOptions,
): Promise<{ results: MigrationResult[]; labels: Map<string, string> }> {
  const results: MigrationResult[] = [];
  const labels = new Map<string, string>();
  let current = 0;
  const verb = options.checkOnly ? 'Checking' : 'Migrating';

  for (const workspace of workspaceList) {
    current++;
    const label = workspaceLabel(current, workspace.name, workspace.id);
    labels.set(workspace.id, label);
    console.log(`[${current}/${workspaceList.length}] ${verb}: ${label}`);

    const result = await migrateWorkspace(workspace, migrationsFolder, options);
    results.push(result);

    if (result.success) {
      console.log(`  Status: SUCCESS`);
      if (result.appliedSkipped?.length) console.log(`  Applied skipped: ${result.appliedSkipped.join(', ')}`);
      if (result.journalGap) console.log(`  Journal: ${result.journalGap}`);
      console.log('');
    } else {
      console.log(`  Status: FAILED`);
      console.log(`  Error:  ${result.error}\n`);
    }
  }

  return { results, labels };
}

/** Workspaces still missing journal migrations: a warning (a GitHub annotation in CI), never a failure. */
function printJournalGaps(results: MigrationResult[], labels: Map<string, string>, applySkipped: boolean): void {
  const gaps = results.filter((r) => r.success && r.journalGap);
  if (gaps.length === 0) return;
  console.log(`\nWorkspaces missing journal migrations (${gaps.length}):`);
  for (const r of gaps) console.log(`  - ${labels.get(r.workspaceId) ?? r.workspaceId}: ${r.journalGap}`);
  if (!applySkipped) console.log('  Run with --apply-skipped to apply the missing migrations.');
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::warning title=Tenant migrations skipped::${gaps.length} workspace(s) miss journal migrations ` +
        `drizzle skipped (merged with an older timestamp). See the run log; apply with --apply-skipped.`,
    );
  }
}

function printSummary(
  results: MigrationResult[],
  labels: Map<string, string>,
  skippedCount: number,
  applySkipped: boolean,
): void {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log('\n===========================================');
  console.log('  Migration Summary');
  console.log('===========================================');
  console.log(`  Total:      ${results.length}`);
  console.log(`  Successful: ${successful.length}`);
  console.log(`  Failed:     ${failed.length}`);
  // Not part of Total and never a failure: the next run migrates these workspaces.
  console.log(`  Skipped:    ${skippedCount} (database move in progress)`);
  console.log(`  Journal gaps: ${results.filter((r) => r.success && r.journalGap).length}`);

  printJournalGaps(results, labels, applySkipped);

  if (failed.length > 0) {
    console.log('\nFailed workspaces:');
    for (const f of failed) {
      console.log(`  - ${labels.get(f.workspaceId) ?? f.workspaceId}`);
      console.log(`    Error: ${f.error}`);
    }
    if (redactWorkspaces) {
      console.log('\n  Re-run locally with --show-workspaces to identify them.');
    }
    console.log('');
    process.exit(1);
  }

  console.log('\nAll migrations completed successfully!\n');
}

async function main(): Promise<void> {
  const options = parseArgs();
  redactWorkspaces = options.redact;

  console.log('\n===========================================');
  console.log('  Multi-Tenant Database Migration Tool');
  console.log('===========================================\n');

  // Validate environment
  const masterDbUrl = process.env.MASTER_DATABASE_URL;
  if (!masterDbUrl) {
    console.error('Error: MASTER_DATABASE_URL environment variable is required');
    console.error('Please set it in your .env file or environment');
    process.exit(1);
  }

  // Resolve migrations folder path
  const migrationsFolder = path.resolve(__dirname, '../../../../packages/core/db/drizzle/tenant-migrations');
  console.log(`Migrations folder: ${migrationsFolder}`);

  const journal = loadTenantJournal(migrationsFolder);

  if (options.dryRun) {
    console.log('Mode: DRY RUN (no migrations will be executed)\n');
  } else if (options.checkJournal) {
    console.log('Mode: CHECK JOURNAL (connects to every tenant, changes nothing)\n');
  } else {
    console.log(`Mode: LIVE (migrations will be applied${options.applySkipped ? ', skipped ones too' : ''})\n`);
  }

  if (redactWorkspaces) {
    console.log('Output: REDACTED (workspace details hidden, use --show-workspaces to reveal)\n');
  }

  // Connect to master database
  console.log('Connecting to master database...');
  const masterClient = postgres(masterDbUrl, { max: 1 });

  try {
    // Fetch workspaces
    console.log('Fetching workspaces...\n');
    const { workspaces: workspaceList, skipped } = await getWorkspaces(masterClient, options.only);

    printSkippedWorkspaces(skipped);

    if (workspaceList.length === 0) {
      if (skipped.length > 0) {
        console.log(`Nothing to migrate now. Skipped: ${skipped.length} (database move in progress).`);
      } else {
        printNoWorkspacesFound(options.only);
      }
      return;
    }

    console.log(`Found ${workspaceList.length} workspace(s) to migrate:\n`);
    console.log('-------------------------------------------');

    // List workspaces
    printWorkspaceList(workspaceList);
    console.log('-------------------------------------------\n');

    // If dry run, stop here
    if (options.dryRun) {
      console.log('Dry run complete. No migrations were executed.');
      return;
    }

    // Run migrations (or, with --check-journal, only look)
    console.log(options.checkJournal ? 'Checking journals...\n' : 'Starting migrations...\n');
    const { results, labels } = await runMigrations(workspaceList, migrationsFolder, {
      verbose: options.verbose,
      journal,
      applySkipped: options.applySkipped,
      checkOnly: options.checkJournal,
    });

    // Print summary (exits with code 1 when any workspace failed)
    printSummary(results, labels, skipped.length, options.applySkipped);
  } finally {
    await masterClient.end();
  }
}

// Run main function
try {
  await main();
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('Fatal error:', sanitizeMessage(message));
  process.exit(1);
}
