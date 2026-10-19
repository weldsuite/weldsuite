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

// ============ Tenant Pool Cache ============
//
// One WebSocket Pool per workspace, reused across requests. A pool is tied to
// the connection it was opened for: when the workspace's database coordinates
// or stored URL change (a database move, a password rotation), or the pool
// gets old, it is closed and a new one is opened. Pool sessions survive a
// password rotation on Neon, so without this a long-lived process would keep
// writing to a database that was moved away (TASK-1150, ADR DATA-016).

interface CachedTenantPool {
  db: NeonDatabase<typeof tenantSchema>;
  pool: Pool;
  /** The workspace's connection coordinates when the pool was opened. */
  fingerprint: string;
  createdAt: number;
}

/** Recycle pools at the same pace the workspace info below refreshes. */
const POOL_MAX_AGE_MS = 5 * 60 * 1000;

// Global singleton to prevent connection leaks during hot reload in development
const globalForTenantPools = globalThis as unknown as {
  tenantPoolCache: Map<string, CachedTenantPool> | undefined;
};

const tenantPoolCache = globalForTenantPools.tenantPoolCache ?? new Map<string, CachedTenantPool>();

if (process.env.NODE_ENV !== 'production') {
  globalForTenantPools.tenantPoolCache = tenantPoolCache;
}

type WorkspaceConnection = Pick<
  typeof workspaces.$inferSelect,
  'id' | 'neonProjectId' | 'neonBranchId' | 'neonRoleName' | 'neonDatabaseName' | 'databaseUrl'
>;

/** Changes whenever the workspace points at another database or its stored URL changes. */
function connectionFingerprint(workspace: WorkspaceConnection): string {
  return [
    workspace.neonProjectId,
    workspace.neonBranchId,
    workspace.neonRoleName,
    workspace.neonDatabaseName ?? '',
    workspace.databaseUrl ?? '',
  ].join('|');
}

function closeTenantPool(entry: CachedTenantPool): void {
  // In-flight queries finish; idle and released clients are closed.
  entry.pool.end().catch((error: unknown) => {
    console.warn('Closing a tenant pool failed:', error instanceof Error ? error.message : error);
  });
}

// ============ End Tenant Pool Cache ============

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
  try {
    const clerkClient = await getClerkClient();
    if (clerkClient) {
      const clerk = await clerkClient();
      const org = await clerk.organizations.getOrganization({ organizationId: clerkOrgId });
      orgName = org.name;
      orgSlug = org.slug || generateSlug(org.name);
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
function fetchWorkspaceInfo(clerkOrgId: string) {
  return masterDb
    .select({
      workspace: workspaces,
      plan: plans,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.clerkOrgId, clerkOrgId));
}

function fetchWorkspaceInfoById(workspaceId: string) {
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
  if (cached?.workspace.isActive) {
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

/**
 * Return the workspace's pooled tenant DB, opening a new pool when there is
 * none, when the workspace now points at another database or URL, or when the
 * cached pool is older than {@link POOL_MAX_AGE_MS}.
 */
async function getOrCreateTenantPool(workspace: WorkspaceConnection): Promise<NeonDatabase<typeof tenantSchema>> {
  const fingerprint = connectionFingerprint(workspace);
  const existing = tenantPoolCache.get(workspace.id);
  if (existing && existing.fingerprint === fingerprint && Date.now() - existing.createdAt < POOL_MAX_AGE_MS) {
    return existing.db;
  }
  if (existing) {
    tenantPoolCache.delete(workspace.id);
    closeTenantPool(existing);
  }

  const { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: storedUrl } = workspace;
  if (!neonProjectId || !neonBranchId || !neonRoleName) {
    throw new Error('Workspace has no database configured');
  }
  const databaseUrl = await resolveDatabaseUrl(
    process.env.NEON_API_KEY!,
    { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl: storedUrl },
    { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const pool = new Pool({ connectionString: databaseUrl });
  // An idle client whose session is ended server-side (a terminated backend
  // during a database move, a compute restart) emits 'error' on the pool.
  // Unhandled, that event would crash the process.
  pool.on('error', (error: Error) => {
    console.warn(`Tenant pool for ${workspace.id} lost a client:`, error.message);
  });
  const db = drizzle({ client: pool, schema: tenantSchema });
  tenantPoolCache.set(workspace.id, { db, pool, fingerprint, createdAt: Date.now() });
  return db;
}

/**
 * Close a workspace's pooled tenant DB and forget its cached workspace info,
 * so the next call reads the master DB again and opens a fresh pool. Use it
 * when a tenant query fails because the database moved or its password changed.
 */
export function evictTenantDb(workspaceId: string, clerkOrgId?: string | null): void {
  const entry = tenantPoolCache.get(workspaceId);
  if (entry) {
    tenantPoolCache.delete(workspaceId);
    closeTenantPool(entry);
  }
  workspaceInfoCache.delete(`ws:${workspaceId}`);
  if (clerkOrgId) workspaceInfoCache.delete(`org:${clerkOrgId}`);
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
  if (cached?.workspace.isActive && cached.workspace.databaseUrl) {
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
  const db = await getOrCreateTenantPool(workspace);

  return {
    db,
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

  if (cached?.workspace.isActive && cached.workspace.databaseUrl) {
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

  const db = await getOrCreateTenantPool(workspace);

  return {
    db,
    workspaceId: workspace.id,
    tier,
  };
}

/**
 * Thrown by {@link getExistingTenantDb} when no active workspace matches the
 * given id. Public, unauthenticated callers (the meeting portal) map it to a
 * 404 instead of letting an unknown id surface as a 500.
 */
export class TenantNotFoundError extends Error {
  readonly code = 'TENANT_NOT_FOUND' as const;
  constructor(id: string) {
    super(`No active workspace found for ${id}`);
    this.name = 'TenantNotFoundError';
  }
}

/** Duck-typed check that also works across duplicated module instances. */
export function isTenantNotFoundError(err: unknown): err is TenantNotFoundError {
  return (
    err instanceof TenantNotFoundError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'TENANT_NOT_FOUND')
  );
}

/**
 * Resolve a tenant database from a workspace id OR a Clerk org id WITHOUT
 * ever provisioning anything. Unlike {@link getTenantDb}, an unknown id does
 * not create a phantom `workspaces` row: it throws {@link TenantNotFoundError}.
 * Meant for public routes whose id comes from a URL anyone can edit.
 */
export async function getExistingTenantDb(id: string) {
  // Same workspace-info cache the authenticated paths use (`ws:` / `org:` keys;
  // only fully provisioned, active workspaces are ever stored), so the portal's
  // polled routes do not hit the master DB on every request.
  const cached = getCachedWorkspaceInfo(`ws:${id}`) ?? getCachedWorkspaceInfo(`org:${id}`);
  if (cached?.workspace.isActive && cached.workspace.databaseUrl) {
    const { workspace, tier } = cached;
    // Seed the id-keyed entry so getTenantDbByWorkspaceId below is cache-only too.
    if (!getCachedWorkspaceInfo(`ws:${workspace.id}`)) setCachedWorkspaceInfo(`ws:${workspace.id}`, workspace, tier);
    const hit = await getTenantDbByWorkspaceId(workspace.id);
    return { ...hit, clerkOrgId: workspace.clerkOrgId ?? null };
  }

  let [result] = await fetchWorkspaceInfoById(id);
  if (!result) [result] = await fetchWorkspaceInfo(id);
  if (!result?.workspace.isActive) throw new TenantNotFoundError(id);
  // No tenant database (never provisioned, or a phantom row the old
  // auto-provisioning `getTenantDb` created for a made-up org id): nothing a
  // public caller can reach, so it is "not found" rather than a 500.
  const { neonProjectId, neonBranchId, neonRoleName } = result.workspace;
  if (!neonProjectId || !neonBranchId || !neonRoleName) throw new TenantNotFoundError(id);

  // Remember a fully provisioned workspace under its workspace id (read by
  // getTenantDbByWorkspaceId right below) and its Clerk org id.
  if (result.workspace.databaseUrl) {
    const tier = getTierFromPlan(result.plan?.slug);
    setCachedWorkspaceInfo(`ws:${result.workspace.id}`, result.workspace, tier);
    if (result.workspace.clerkOrgId) {
      setCachedWorkspaceInfo(`org:${result.workspace.clerkOrgId}`, result.workspace, tier);
    }
  }

  const tenant = await getTenantDbByWorkspaceId(result.workspace.id);
  return {
    ...tenant,
    clerkOrgId: result.workspace.clerkOrgId ?? null,
  };
}

// Type for tenant database
export type TenantDb = Awaited<ReturnType<typeof getTenantDb>>;
