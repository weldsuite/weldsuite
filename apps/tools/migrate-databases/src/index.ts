#!/usr/bin/env node

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for resolving migration path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI argument parsing
interface CliOptions {
  dryRun: boolean;
  only: string | null;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    dryRun: false,
    only: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--only' && args[i + 1]) {
      options.only = args[++i] ?? null;
    } else if (arg === '--verbose') {
      options.verbose = true;
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
  --dry-run        List all workspaces without running migrations
  --only <id>      Migrate only a specific workspace by ID (Clerk org ID)
  --verbose        Show detailed migration output
  --help, -h       Show this help message

Examples:
  pnpm migrate                    # Run migrations on all workspace databases
  pnpm migrate:dry-run            # List all workspaces and their databases
  pnpm migrate -- --only org_123  # Migrate only workspace org_123
  pnpm migrate -- --verbose       # Run with detailed output
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
}

async function getWorkspaces(masterClient: postgres.Sql, only: string | null): Promise<WorkspaceInfo[]> {
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

  // Resolve connection URIs — uses stored databaseUrl when available,
  // falls back to Neon API only if needed
  const resolved: WorkspaceInfo[] = [];
  for (const w of result) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    const databaseUrl = await resolveDatabaseUrl(neonApiKey, w as any, encryptionKey);
    resolved.push({ id: w.id, name: w.name, databaseUrl, neonProjectId: w.neonProjectId });
  }

  return resolved;
}

async function migrateWorkspace(
  workspace: WorkspaceInfo,
  migrationsFolder: string,
  verbose: boolean
): Promise<MigrationResult> {
  let client: postgres.Sql | null = null;

  try {
    if (verbose) {
      console.log(`  Connecting to database...`);
    }

    // Create connection with SSL (Neon requires SSL)
    client = postgres(workspace.databaseUrl, {
      max: 1,
      onnotice: verbose ? (msg) => console.log(`  Notice: ${msg.message}`) : () => {},
    });

    const db = drizzle(client);

    if (verbose) {
      console.log(`  Running migrations from: ${migrationsFolder}`);
    }

    await migrate(db, { migrationsFolder, migrationsSchema: 'public' });

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      success: false,
      error: errorMessage,
    };
  } finally {
    if (client) {
      await client.end();
    }
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

async function main(): Promise<void> {
  const options = parseArgs();

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

  if (options.dryRun) {
    console.log('Mode: DRY RUN (no migrations will be executed)\n');
  } else {
    console.log('Mode: LIVE (migrations will be applied)\n');
  }

  // Connect to master database
  console.log('Connecting to master database...');
  const masterClient = postgres(masterDbUrl, { max: 1 });

  try {
    // Fetch workspaces
    console.log('Fetching workspaces...\n');
    const workspaceList = await getWorkspaces(masterClient, options.only);

    if (workspaceList.length === 0) {
      if (options.only) {
        console.log(`No active workspace found with ID: ${options.only}`);
      } else {
        console.log('No active workspaces with database URLs found.');
      }
      return;
    }

    console.log(`Found ${workspaceList.length} workspace(s) to migrate:\n`);
    console.log('-------------------------------------------');

    // List workspaces
    for (const workspace of workspaceList) {
      console.log(`  ID:   ${workspace.id}`);
      console.log(`  Name: ${workspace.name}`);
      console.log(`  DB:   ${maskDatabaseUrl(workspace.databaseUrl)}`);
      console.log('');
    }
    console.log('-------------------------------------------\n');

    // If dry run, stop here
    if (options.dryRun) {
      console.log('Dry run complete. No migrations were executed.');
      return;
    }

    // Run migrations
    console.log('Starting migrations...\n');
    const results: MigrationResult[] = [];
    let current = 0;

    for (const workspace of workspaceList) {
      current++;
      console.log(`[${current}/${workspaceList.length}] Migrating: ${workspace.name} (${workspace.id})`);

      const result = await migrateWorkspace(workspace, migrationsFolder, options.verbose);
      results.push(result);

      if (result.success) {
        console.log(`  Status: SUCCESS\n`);
      } else {
        console.log(`  Status: FAILED`);
        console.log(`  Error:  ${result.error}\n`);
      }
    }

    // Print summary
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    console.log('\n===========================================');
    console.log('  Migration Summary');
    console.log('===========================================');
    console.log(`  Total:      ${results.length}`);
    console.log(`  Successful: ${successful.length}`);
    console.log(`  Failed:     ${failed.length}`);

    if (failed.length > 0) {
      console.log('\nFailed workspaces:');
      for (const f of failed) {
        console.log(`  - ${f.workspaceName} (${f.workspaceId})`);
        console.log(`    Error: ${f.error}`);
      }
      console.log('');
      process.exit(1);
    }

    console.log('\nAll migrations completed successfully!\n');
  } finally {
    await masterClient.end();
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
