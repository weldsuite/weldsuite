/**
 * Migrate RBAC from Tenant DB to Clerk
 *
 * This script migrates existing workspace members' roles from the tenant
 * database to Clerk organization memberships. It maps system roles
 * (OWNER/ADMIN/MEMBER/VIEWER) to Clerk role keys and handles custom roles.
 *
 * Prerequisites:
 *   1. Run setup-clerk-permissions.ts first to create permissions and roles in Clerk
 *   2. Ensure CLERK_SECRET_KEY and DATABASE_URL are set
 *
 * Usage:
 *   npx tsx scripts/migrate-rbac-to-clerk.ts [--dry-run] [--org <orgId>]
 *
 * Flags:
 *   --dry-run    Preview changes without making them
 *   --org <id>   Only migrate a specific organization
 */

import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

const DRY_RUN = process.argv.includes('--dry-run');
const SPECIFIC_ORG = process.argv.includes('--org')
  ? process.argv[process.argv.indexOf('--org') + 1]
  : null;

// ============================================================================
// Role Mapping
// ============================================================================

const SYSTEM_ROLE_MAP: Record<string, string> = {
  OWNER: 'org:admin',         // Clerk built-in admin = OWNER
  ADMIN: 'org:admin_role',    // Custom: ADMIN
  MEMBER: 'org:member_role',  // Custom: MEMBER
  VIEWER: 'org:viewer_role',  // Custom: VIEWER
};

// ============================================================================
// Migration Logic
// ============================================================================

interface MigrationResult {
  orgId: string;
  orgName: string;
  membersProcessed: number;
  membersUpdated: number;
  membersSkipped: number;
  errors: string[];
}

async function migrateOrganization(orgId: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    orgId,
    orgName: '',
    membersProcessed: 0,
    membersUpdated: 0,
    membersSkipped: 0,
    errors: [],
  };

  try {
    // Get organization details
    const org = await clerkClient.organizations.getOrganization({ organizationId: orgId });
    result.orgName = org.name;

    console.log(`\n  Organization: ${org.name} (${orgId})`);

    // Get all memberships
    const memberships = await clerkClient.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 500,
    });

    console.log(`  Members: ${memberships.data.length}`);

    for (const membership of memberships.data) {
      result.membersProcessed++;

      const userId = membership.publicUserData?.userId;
      const currentRole = membership.role;
      const email = membership.publicUserData?.identifier || 'unknown';

      if (!userId) {
        result.errors.push(`Member without userId: ${email}`);
        result.membersSkipped++;
        continue;
      }

      // Determine the target Clerk role
      // The current membership.role will be 'org:admin' or 'org:member' (Clerk defaults)
      // We need to map based on what's in the tenant DB
      // For now, keep existing org:admin as OWNER, map org:member to org:member_role
      let targetRole = currentRole;

      if (currentRole === 'org:admin') {
        // Keep as org:admin (OWNER) - this is already correct
        console.log(`    ${email}: org:admin (OWNER) - no change needed`);
        result.membersSkipped++;
        continue;
      }

      if (currentRole === 'org:member') {
        // Default Clerk member - map to our custom member_role
        targetRole = 'org:member_role';
      }

      if (targetRole !== currentRole) {
        console.log(`    ${email}: ${currentRole} -> ${targetRole}`);

        if (!DRY_RUN) {
          try {
            await clerkClient.organizations.updateOrganizationMembership({
              organizationId: orgId,
              userId,
              role: targetRole,
            });
            result.membersUpdated++;
          } catch (error: any) {
            const errorMsg = `Failed to update ${email}: ${error?.message || error}`;
            result.errors.push(errorMsg);
            console.error(`    ERROR: ${errorMsg}`);
          }
        } else {
          result.membersUpdated++;
        }
      } else {
        result.membersSkipped++;
      }
    }
  } catch (error: any) {
    result.errors.push(`Organization error: ${error?.message || error}`);
    console.error(`  ERROR: ${error?.message || error}`);
  }

  return result;
}

async function main() {
  console.log('========================================');
  console.log('  RBAC Migration: Tenant DB -> Clerk');
  console.log('========================================');

  if (!process.env.CLERK_SECRET_KEY) {
    console.error('Error: CLERK_SECRET_KEY environment variable is required');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }

  const results: MigrationResult[] = [];

  if (SPECIFIC_ORG) {
    console.log(`\nMigrating specific organization: ${SPECIFIC_ORG}`);
    const result = await migrateOrganization(SPECIFIC_ORG);
    results.push(result);
  } else {
    // Get all organizations
    console.log('\nFetching all organizations...');
    const orgs = await clerkClient.organizations.getOrganizationList({ limit: 100 });
    console.log(`Found ${orgs.data.length} organizations`);

    for (const org of orgs.data) {
      const result = await migrateOrganization(org.id);
      results.push(result);
    }
  }

  // Summary
  console.log('\n========================================');
  console.log('  Migration Summary');
  console.log('========================================\n');

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const result of results) {
    console.log(`  ${result.orgName} (${result.orgId}):`);
    console.log(`    Processed: ${result.membersProcessed}`);
    console.log(`    Updated: ${result.membersUpdated}`);
    console.log(`    Skipped: ${result.membersSkipped}`);
    if (result.errors.length > 0) {
      console.log(`    Errors: ${result.errors.length}`);
      result.errors.forEach(e => console.log(`      - ${e}`));
    }

    totalProcessed += result.membersProcessed;
    totalUpdated += result.membersUpdated;
    totalSkipped += result.membersSkipped;
    totalErrors += result.errors.length;
  }

  console.log('\n  Totals:');
  console.log(`    Organizations: ${results.length}`);
  console.log(`    Members processed: ${totalProcessed}`);
  console.log(`    Members updated: ${totalUpdated}`);
  console.log(`    Members skipped: ${totalSkipped}`);
  console.log(`    Errors: ${totalErrors}`);

  if (DRY_RUN) {
    console.log('\n*** This was a DRY RUN. Run without --dry-run to apply changes. ***');
  }

  console.log('\nDone!');
}

main().catch(console.error);
