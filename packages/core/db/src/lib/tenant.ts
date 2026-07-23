// TODO: This file has platform-specific dependencies that need to be made injectable:
// - @clerk/nextjs/server (clerkClient) - used for workspace auto-provisioning
// These dependencies will be addressed in a future phase to make this package reusable.

import { eq, and, isNull } from 'drizzle-orm';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { masterDb } from './master';
import { workspaces, plans, type Workspace, type TenantTier } from '../schema/master';
import { resolveDatabaseUrl } from './neon-resolve';
import * as tenantSchema from '../schema';

// Use ws for WebSocket support on Node.js 20 (built-in WebSocket requires Node.js 22+)
neonConfig.webSocketConstructor = ws;

// Dynamic import for Clerk - may not be available in all environments
let clerkClientModule: typeof import('@clerk/nextjs/server') | null = null;
async function getClerkClient() {
  if (!clerkClientModule) {
    try {
      clerkClientModule = await import('@clerk/nextjs/server');
    } catch {
      return null;
    }
  }
  return clerkClientModule.clerkClient;
}

// Billing is managed via billing-worker (Stripe)

// Global singleton to prevent connection leaks during hot reload in development
const globalForDedicatedDb = globalThis as unknown as {
  dedicatedDbCache: Map<string, NeonDatabase<typeof tenantSchema>> | undefined;
  dedicatedPoolCache: Map<string, Pool> | undefined;
};

// Cache for dedicated database connections (to avoid creating new connections per request)
const dedicatedDbCache = globalForDedicatedDb.dedicatedDbCache ?? new Map<string, NeonDatabase<typeof tenantSchema>>();
const dedicatedPoolCache = globalForDedicatedDb.dedicatedPoolCache ?? new Map<string, Pool>();

if (process.env.NODE_ENV !== 'production') {
  globalForDedicatedDb.dedicatedDbCache = dedicatedDbCache;
  globalForDedicatedDb.dedicatedPoolCache = dedicatedPoolCache;
}

// ============ Workspace Info Cache ============

interface CachedWorkspaceInfo {
  workspace: typeof workspaces.$inferSelect;
  tier: TenantTier;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const globalForWorkspaceCache = globalThis as unknown as {
  workspaceInfoCache: Map<string, CachedWorkspaceInfo> | undefined;
};

const workspaceInfoCache = globalForWorkspaceCache.workspaceInfoCache ?? new Map();

if (process.env.NODE_ENV !== 'production') {
  globalForWorkspaceCache.workspaceInfoCache = workspaceInfoCache;
}

function getCachedWorkspaceInfo(key: string): CachedWorkspaceInfo | null {
  const cached = workspaceInfoCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (cached) workspaceInfoCache.delete(key); // expired
  return null;
}

function setCachedWorkspaceInfo(key: string, workspace: typeof workspaces.$inferSelect, tier: TenantTier) {
  workspaceInfoCache.set(key, {
    workspace,
    tier,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ============ End Workspace Info Cache ============

export interface TenantInfo {
  workspaceId: string;
  clerkOrgId: string;
  name: string;
  tier: TenantTier;
  planId: string | null;
}

// Helper to get tier from plan slug
function getTierFromPlan(planSlug: string | null | undefined): TenantTier {
  if (!planSlug) return 'free';
  if (['free', 'business', 'scale', 'enterprise'].includes(planSlug)) {
    return planSlug as TenantTier;
  }
  return 'free';
}

// Generate a URL-friendly slug from a name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

// Auto-provision a workspace for a new Clerk organization
async function provisionWorkspace(clerkOrgId: string): Promise<Workspace> {
  // Fetch org details from Clerk
  let orgName = 'My Workspace';
  let orgSlug = clerkOrgId;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let orgEmail: string | undefined;

  try {
    const clerkClient = await getClerkClient();
    if (clerkClient) {
      const clerk = await clerkClient();
      const org = await clerk.organizations.getOrganization({ organizationId: clerkOrgId });
      orgName = org.name;
      orgSlug = org.slug || generateSlug(org.name);

      // Try to get admin email from the organization creator
      const memberships = await clerk.organizations.getOrganizationMembershipList({
        organizationId: clerkOrgId,
        limit: 1,
      });
      if (memberships.data[0]?.publicUserData?.identifier) {
        orgEmail = memberships.data[0].publicUserData.identifier;
      }
    }
  } catch (error) {
    console.warn('Could not fetch Clerk org details, using defaults:', error);
  }

  // Find the default plan (or first active plan as fallback)
  const [defaultPlan] = await masterDb
    .select()
    .from(plans)
    .where(and(
      eq(plans.isDefault, true),
      isNull(plans.deletedAt)
    ))
    .limit(1);

  // Create workspace in master database
  const [newWorkspace] = await masterDb
    .insert(workspaces)
    .values({
      id: clerkOrgId, // Use Clerk org ID as workspace ID for simplicity
      clerkOrgId,
      name: orgName,
      slug: `${orgSlug}-${Date.now()}`, // Ensure uniqueness
      planId: defaultPlan?.id || null,
      isActive: true,
    })
    .returning();

  // TODO: Stripe customer creation disabled - will be made injectable for external-api
  // const stripeCustomerId = await createStripeCustomer({...});
  // For now, Stripe customer can be created later via platform app

  if (!newWorkspace) {
    throw new Error(`Failed to provision workspace for Clerk org ${clerkOrgId}`);
  }

  console.log(`Provisioned new workspace: ${newWorkspace.id} (${newWorkspace.name})`);
  return newWorkspace;
}

// Helper to query workspace + plan from master DB
async function fetchWorkspaceInfo(clerkOrgId: string) {
  return masterDb
    .select({
      workspace: workspaces,
      plan: plans,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.clerkOrgId, clerkOrgId));
}

async function fetchWorkspaceInfoById(workspaceId: string) {
  return masterDb
    .select({
      workspace: workspaces,
      plan: plans,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.id, workspaceId));
}

// Get tenant info from master database (with auto-provisioning)
export async function getTenantInfo(clerkOrgId: string): Promise<TenantInfo | null> {
  // Check cache first
  const cached = getCachedWorkspaceInfo(`org:${clerkOrgId}`);
  if (cached && cached.workspace.isActive) {
    return {
      workspaceId: cached.workspace.id,
      clerkOrgId,
      name: cached.workspace.name,
      tier: cached.tier,
      planId: cached.workspace.planId,
    };
  }

  let [result] = await fetchWorkspaceInfo(clerkOrgId);

  // Auto-provision if workspace doesn't exist
  if (!result) {
    try {
      const workspace = await provisionWorkspace(clerkOrgId);
      // Re-fetch with plan join
      [result] = await masterDb
        .select({
          workspace: workspaces,
          plan: plans,
        })
        .from(workspaces)
        .leftJoin(plans, eq(workspaces.planId, plans.id))
        .where(eq(workspaces.id, workspace.id));
    } catch (error) {
      console.error('Failed to provision workspace:', error);
      return null;
    }
  }

  if (!result?.workspace.isActive) {
    return null;
  }

  const tier = getTierFromPlan(result.plan?.slug);

  // Only cache if fully provisioned (databaseUrl is set) — avoids stale reads
  // where getTenantDb picks up a cached workspace with databaseUrl: null
  if (result.workspace.databaseUrl) {
    setCachedWorkspaceInfo(`org:${clerkOrgId}`, result.workspace, tier);
  }

  return {
    workspaceId: result.workspace.id,
    clerkOrgId,
    name: result.workspace.name,
    tier,
    planId: result.workspace.planId,
  };
}

// Create a Neon Pool-backed tenant DB connection
function createTenantPool(databaseUrl: string): NeonDatabase<typeof tenantSchema> {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle({ client: pool, schema: tenantSchema });
}

// Get the appropriate database for a tenant (with auto-provisioning)
export async function getTenantDb(clerkOrgId: string) {
  // Check workspace info cache first
  const cached = getCachedWorkspaceInfo(`org:${clerkOrgId}`);
  let workspace: typeof workspaces.$inferSelect;
  let tier: TenantTier;

  // Use cache only if workspace is fully provisioned (has databaseUrl).
  // During provisioning the databaseUrl is null until the migration task completes,
  // so caching that state would cause stale reads for up to 5 minutes.
  if (cached && cached.workspace.isActive && cached.workspace.databaseUrl) {
    workspace = cached.workspace;
    tier = cached.tier;
  } else {
    let [result] = await fetchWorkspaceInfo(clerkOrgId);

    // Auto-provision if workspace doesn't exist
    if (!result) {
      try {
        const ws = await provisionWorkspace(clerkOrgId);
        // Re-fetch with plan join
        [result] = await masterDb
          .select({
            workspace: workspaces,
            plan: plans,
          })
          .from(workspaces)
          .leftJoin(plans, eq(workspaces.planId, plans.id))
          .where(eq(workspaces.id, ws.id));
      } catch (error) {
        console.error('Failed to provision workspace:', error);
        throw new Error('Could not create workspace');
      }
    }

    if (!result?.workspace.isActive) {
      throw new Error('Workspace is inactive');
    }

    workspace = result.workspace;
    tier = getTierFromPlan(result.plan?.slug);

    // Only cache if fully provisioned (databaseUrl is set)
    if (workspace.databaseUrl) {
      setCachedWorkspaceInfo(`org:${clerkOrgId}`, workspace, tier);
    }
  }

  // Every workspace must have its own database - no shared database fallback
  const { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: workspaceDbUrl } = workspace;
  if (!neonProjectId || !neonBranchId || !neonRoleName) {
    throw new Error('Workspace has no database configured');
  }

  // Get or create dedicated database connection
  let dedicatedDb = dedicatedDbCache.get(workspace.id);

  // Invalidate pool if workspace now has a databaseUrl but pool was created via Neon API fallback
  if (!dedicatedDb) {
    const databaseUrl = await resolveDatabaseUrl(
      process.env.NEON_API_KEY!,
      { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: workspaceDbUrl },
      { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 },
    );
    dedicatedDb = createTenantPool(databaseUrl);
    dedicatedDbCache.set(workspace.id, dedicatedDb);
  }

  return {
    db: dedicatedDb,
    workspaceId: workspace.id,
    tier,
  };
}

/**
 * Get tenant database by workspace ID directly.
 * Use this for webhooks and internal APIs that don't have Clerk context
 * but already know the workspaceId.
 */
export async function getTenantDbByWorkspaceId(workspaceId: string) {
  // Check workspace info cache first
  const cached = getCachedWorkspaceInfo(`ws:${workspaceId}`);
  let workspace: typeof workspaces.$inferSelect;
  let tier: TenantTier;

  if (cached && cached.workspace.isActive && cached.workspace.databaseUrl) {
    workspace = cached.workspace;
    tier = cached.tier;
  } else {
    const [result] = await fetchWorkspaceInfoById(workspaceId);

    if (!result?.workspace.isActive) {
      throw new Error('Workspace not found or inactive');
    }

    workspace = result.workspace;
    tier = getTierFromPlan(result.plan?.slug);

    // Only cache if fully provisioned (databaseUrl is set)
    if (workspace.databaseUrl) {
      setCachedWorkspaceInfo(`ws:${workspaceId}`, workspace, tier);
    }
  }

  const { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: workspaceDbUrl } = workspace;
  if (!neonProjectId || !neonBranchId || !neonRoleName) {
    throw new Error('Workspace has no database configured');
  }

  // Get or create dedicated database connection
  let dedicatedDb = dedicatedDbCache.get(workspaceId);

  if (!dedicatedDb) {
    const databaseUrl = await resolveDatabaseUrl(
      process.env.NEON_API_KEY!,
      { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: workspaceDbUrl },
      { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 },
    );
    dedicatedDb = createTenantPool(databaseUrl);
    dedicatedDbCache.set(workspaceId, dedicatedDb);
  }

  return {
    db: dedicatedDb,
    workspaceId: workspace.id,
    tier,
  };
}

// Type for tenant database
export type TenantDb = Awaited<ReturnType<typeof getTenantDb>>;
