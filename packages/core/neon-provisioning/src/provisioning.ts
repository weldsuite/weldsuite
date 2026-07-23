/**
 * Database Provisioning Service
 *
 * Handles provisioning of Neon databases for workspaces.
 * Every workspace gets its own Neon project (project-per-workspace architecture).
 * Scale-to-zero means idle projects cost only storage (~$0.35/GB/month).
 *
 * After creating the Neon project, triggers a Cloudflare Workflow to handle
 * schema migrations, member insertion, billing setup, and marking provisioned.
 *
 * Extracted verbatim from apps/api-worker/src/services/neon/provisioning.ts
 * (W4 legacy-worker phase-out). The only change from the original is the
 * `generateId` import, which now resolves inside this package instead of
 * reaching into the worker's src. The api-worker copy stays in place until
 * that worker is deleted in W7.
 */

import { eq, and, isNull, sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { NeonClient, createNeonClient } from './client';
import { workspaces, neonSharedProjects, databasePool, type DatabasePool, type NeonSharedProject } from '@weldsuite/db/schema/master';
import { workspaceMembers } from '@weldsuite/db/schema/workspace-members';
import { workspaceInstalledApps } from '@weldsuite/db/schema/workspace-installed-apps';
import { encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { generateId } from './lib/id';

export interface ProvisioningEnv {
  NEON_API_KEY: string;
  NEON_ORG_ID?: string;
  NEON_DEFAULT_REGION?: string;
  /** Cloudflare Workflow binding for async provisioning */
  PROVISION_WORKSPACE?: Workflow;
  /** AES-256 key for encrypting stored connection strings. Optional — when
   *  absent the instant warm-slot path stores the URL in plaintext, matching
   *  the workflow's mark-provisioned behavior. */
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

/** Initial member to insert after migration (typically the org creator) */
export interface InitialMember {
  userId: string;
  email?: string;
  name?: string;
  picture?: string;
  clerkMembershipId?: string;
}

/** Neon-side resources of a freshly created warm pool slot (pre-migration). */
export interface WarmSlotResources {
  /** Pre-generated `database_pool` row id — names are derived from it. */
  poolId: string;
  kind: 'dedicated' | 'shared';
  neonProjectId: string;
  neonBranchId: string;
  connectionHost?: string;
  databaseName: string;
  roleName: string;
  databaseUrl: string;
  /** Shard reference (`neon_shared_projects.id`) for shared slots. */
  sharedProjectId?: string;
  region: string;
  /**
   * True when the slot was cloned from the shard's golden template and is
   * already at the template's schema — the caller can skip migration + seed.
   */
  preMigrated?: boolean;
}

/**
 * Per-shard golden template database: pre-migrated once, then warm slots are
 * created via `CREATE DATABASE ... TEMPLATE` (a storage-level copy, seconds)
 * instead of replaying the full migration journal (~2,600 statements over
 * per-statement HTTP, minutes). Sealed with ALLOW_CONNECTIONS false so copies
 * never hit "source database is being accessed"; its schema version lives in
 * COMMENT ON DATABASE (pg_shdescription), readable without connecting to it.
 */
export const GOLDEN_TEMPLATE_DB = 'weldsuite_golden';
/**
 * NOLOGIN role that owns the golden template's OBJECTS (never the database
 * itself, which stays admin-owned). Copies re-own via
 * `REASSIGN OWNED BY weldsuite_golden_owner TO <slot role>` — safe precisely
 * because this role owns no cluster-shared objects (REASSIGN OWNED also
 * transfers shared objects like databases, so it must never target the admin).
 */
export const GOLDEN_TEMPLATE_ROLE = 'weldsuite_golden_owner';

/** Normalize @neondatabase/serverless query results across driver versions. */
function rowsOf(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: any[] } | null)?.rows ?? [];
}

/** Swap the database name in a postgres:// URI, keeping credentials + params. */
function swapDatabase(uri: string, database: string): string {
  return uri.replace(/\/[^/?]+(\?|$)/, `/${database}$1`);
}

/** Derive the PgBouncer pooler host from a direct Neon endpoint host. */
function poolerHostOf(host: string): string {
  return host.replace(/^([^.]+)/, '$1-pooler');
}

/** 48-hex-char random password (Workers-safe, URI-safe without encoding). */
function generatePassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Transfer every current-database object owned by the executing role to
 * GOLDEN_TEMPLATE_ROLE. Covers what tenant migrations create: tables
 * (incl. partitioned), materialized views, plain views, standalone sequences,
 * and enum/domain/standalone-composite types. Serial/identity sequences and
 * indexes follow their table automatically. Idempotent.
 */
const TRANSFER_GOLDEN_OWNERSHIP_SQL = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS n, c.relkind FROM pg_class c
           JOIN pg_roles o ON o.oid = c.relowner
           WHERE o.rolname = current_user AND c.relkind IN ('r','p','m','S','v')
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend d
               WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                 AND d.deptype IN ('a','i')
             )
  LOOP
    IF r.relkind = 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO ${GOLDEN_TEMPLATE_ROLE}', r.n);
    ELSIF r.relkind = 'v' THEN EXECUTE format('ALTER VIEW %s OWNER TO ${GOLDEN_TEMPLATE_ROLE}', r.n);
    ELSIF r.relkind = 'S' THEN EXECUTE format('ALTER SEQUENCE %s OWNER TO ${GOLDEN_TEMPLATE_ROLE}', r.n);
    ELSE EXECUTE format('ALTER TABLE %s OWNER TO ${GOLDEN_TEMPLATE_ROLE}', r.n);
    END IF;
  END LOOP;
  FOR r IN SELECT t.oid::regtype AS n FROM pg_type t
           JOIN pg_roles o ON o.oid = t.typowner
           JOIN pg_namespace ns ON ns.oid = t.typnamespace
           WHERE o.rolname = current_user AND ns.nspname = 'public'
             AND (t.typtype IN ('e','d') OR (t.typtype = 'c' AND t.typrelid = 0))
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO ${GOLDEN_TEMPLATE_ROLE}', r.n);
  END LOOP;
END $$`;

export interface ProvisioningResult {
  success: boolean;
  workspaceId: string;
  neonProjectId: string;
  neonDatabaseName: string;
  neonBranchId: string;
  neonRoleName?: string;
  isDedicated: boolean;
  connectionUri?: string;
  error?: string;
  /**
   * True when the workspace is ALREADY fully usable when this call returns —
   * a warm pre-migrated slot was claimed and personalized inline (member +
   * apps + ready flags), so callers can skip the provisioning wait entirely.
   * The background workflow still completes the tail (mail, credits, billing).
   */
  ready?: boolean;
}

/**
 * Database Provisioning Service
 */
export class DatabaseProvisioningService {
  private neonClient: NeonClient;
  private defaultRegion: string;
  private env: ProvisioningEnv;

  constructor(env: ProvisioningEnv) {
    this.neonClient = createNeonClient(env);
    this.defaultRegion = env.NEON_DEFAULT_REGION || 'aws-eu-central-1';
    this.env = env;
  }

  /**
   * Trigger async provisioning via Cloudflare Workflow.
   *
   * The workflow handles schema migrations, member insertion, billing setup,
   * and marking the workspace as provisioned. Returns immediately after triggering.
   */
  private async triggerProvisioningWorkflow(
    workspaceId: string,
    databaseUrl: string,
    workspaceName?: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
    slug?: string,
    seedSampleData?: boolean,
  ): Promise<{ success: boolean; instanceId?: string; error?: string }> {
    if (!this.env.PROVISION_WORKSPACE) {
      console.warn('[Provisioning] PROVISION_WORKSPACE workflow binding not available, skipping');
      return { success: false, error: 'Workflow binding not configured' };
    }

    const baseId = `provision-${workspaceId}`;
    const params = { workspaceId, databaseUrl, workspaceName, initialMember, selectedApps, slug, seedSampleData };

    try {
      // If an instance already exists for this workspace, inspect its status.
      // Cloudflare rejects re-creating an instance with an id that already exists,
      // so a previously-failed run can only be retried under a fresh id.
      let existingStatus: string | null = null;
      try {
        const existing = await this.env.PROVISION_WORKSPACE.get(baseId);
        const status = await existing.status();
        existingStatus = typeof status?.status === 'string' ? status.status : null;
      } catch {
        existingStatus = null; // no instance with this id yet → first run
      }

      // Leave a healthy run (still going, or finished cleanly) untouched.
      const liveStatuses = ['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'complete'];
      if (existingStatus && liveStatuses.includes(existingStatus)) {
        console.log(`[Provisioning] Workflow ${baseId} already '${existingStatus}', not re-triggering`);
        return { success: true, instanceId: baseId };
      }

      // First run keeps the deterministic id (idempotency); a retry after an
      // errored/terminated run gets a unique id so it can actually run again.
      const id = existingStatus ? `${baseId}-r${Date.now()}` : baseId;
      console.log(`[Provisioning] Triggering provisioning workflow for ${workspaceId} (id=${id}, previous='${existingStatus ?? 'none'}')`);

      const instance = await this.env.PROVISION_WORKSPACE.create({ id, params });

      console.log(`[Provisioning] Workflow instance created: ${instance.id}`);
      return { success: true, instanceId: instance.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Provisioning] Failed to trigger workflow for ${workspaceId}:`, error);
      return { success: false, error: message };
    }
  }

  /**
   * Rebuild a tenant connection URI from the workspace's stored Neon fields.
   * Used when re-triggering provisioning for a workspace whose database already
   * exists but never finished provisioning (the plaintext/encrypted URL is only
   * persisted at the end of a successful workflow run, so it isn't available
   * yet on the recovery path).
   */
  private async resolveConnectionUri(workspace: {
    id?: string;
    neonProjectId?: string | null;
    neonBranchId?: string | null;
    neonDatabaseName?: string | null;
    neonRoleName?: string | null;
  }): Promise<string | null> {
    if (!workspace?.neonProjectId || !workspace?.neonBranchId || !workspace?.neonRoleName) {
      return null;
    }
    try {
      return await this.neonClient.getConnectionUri(
        workspace.neonProjectId,
        workspace.neonBranchId,
        workspace.neonDatabaseName || 'neondb',
        workspace.neonRoleName,
        { pooled: true },
      );
    } catch (error) {
      console.error(`[Provisioning] Failed to resolve connection URI for ${workspace.id ?? 'unknown'}:`, error);
      return null;
    }
  }

  /**
   * Atomically claim a pre-provisioned warm database slot from the pool.
   * `kind` selects the slot flavor: 'shared' (a database inside a shared
   * shard — free tier) or 'dedicated' (a whole pre-created project — paid).
   * Uses FOR UPDATE SKIP LOCKED for race safety under concurrent onboarding.
   * Returns null if no matching entry is available.
   *
   * Schema-version drift: we don't require an exact `schema_version` match —
   * pool entries that are a few migrations behind are still vastly cheaper
   * than provisioning on-demand. The provisioning workflow's `apply-migrations`
   * step is a delta-applier and will catch the claimed DB up to the bundled
   * latest before any user traffic hits it (only exact-match slots get the
   * inline instant path). We prefer the freshest entry available.
   */
  private async claimFromPool(
    masterDb: any,
    workspaceId: string,
    kind: 'dedicated' | 'shared',
    region: string,
  ): Promise<DatabasePool | null> {
    try {
      const result = await masterDb.execute(
        sql`UPDATE database_pool
            SET status = 'assigned',
                assigned_workspace_id = ${workspaceId},
                assigned_at = NOW()
            WHERE id = (
              SELECT id FROM database_pool
              WHERE status = 'available'
                AND region = ${region}
                AND kind = ${kind}
              ORDER BY schema_version DESC NULLS LAST, created_at DESC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            RETURNING *`
      );

      const row = result.rows?.[0] || result[0];
      if (!row) return null;

      console.log(`[Provisioning] Claimed ${kind} pool entry ${row.id} (project ${row.neon_project_id}) for workspace ${workspaceId}`);
      return {
        id: row.id,
        kind: row.kind,
        neonProjectId: row.neon_project_id,
        neonBranchId: row.neon_branch_id,
        connectionHost: row.connection_host,
        databaseName: row.database_name,
        roleName: row.role_name,
        databaseUrl: row.database_url,
        sharedProjectId: row.shared_project_id,
        schemaVersion: row.schema_version,
        region: row.region,
        status: row.status,
        assignedWorkspaceId: row.assigned_workspace_id,
        assignedAt: row.assigned_at,
        createdAt: row.created_at,
      } as DatabasePool;
    } catch (error) {
      console.warn('[Provisioning] Pool claim failed, will fall back to on-demand:', error);
      return null;
    }
  }

  /**
   * Assign a claimed warm slot to a workspace and, when the slot's schema is
   * current, personalize it inline (member + apps + connection URL + ready
   * flags) so the caller can report the workspace as usable IMMEDIATELY.
   * The provisioning workflow is still triggered for the tail (mail account,
   * digest, credits, billing, optional seeds) — its early steps are
   * idempotent no-ops by then.
   */
  private async activateWarmSlot(
    masterDb: any,
    claimed: DatabasePool,
    workspaceId: string,
    workspaceName: string,
    latestSchemaVersion?: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
    slug?: string,
    seedSampleData?: boolean,
  ): Promise<ProvisioningResult> {
    const region = claimed.region || this.defaultRegion;

    // Atomic claim — only the first provisioning call to set neon_project_id
    // wins (same double-trigger guard as the on-demand shared path).
    const rows = await masterDb
      .update(workspaces)
      .set({
        neonProjectId: claimed.neonProjectId,
        neonDatabaseName: claimed.databaseName,
        neonBranchId: claimed.neonBranchId,
        neonRoleName: claimed.roleName,
        neonRegion: region,
        sharedProjectId: claimed.sharedProjectId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.neonProjectId)))
      .returning({ id: workspaces.id });

    if (rows.length === 0) {
      // Lost the provisioning race — return the slot to the pool and defer
      // to the winner's database assignment.
      console.log(`[Provisioning] Lost provisioning race for ${workspaceId}; returning slot ${claimed.id} to pool`);
      await masterDb
        .update(databasePool)
        .set({ status: 'available', assignedWorkspaceId: null, assignedAt: null })
        .where(eq(databasePool.id, claimed.id));

      const [winner] = await masterDb.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      return {
        success: true,
        workspaceId,
        neonProjectId: winner?.neonProjectId || '',
        neonDatabaseName: winner?.neonDatabaseName || 'neondb',
        neonBranchId: winner?.neonBranchId || '',
        neonRoleName: winner?.neonRoleName || undefined,
        isDedicated: !winner?.sharedProjectId,
      };
    }

    console.log(
      `[Provisioning] Workspace ${workspaceId} assigned warm ${claimed.kind} slot ${claimed.id} ` +
      `(project ${claimed.neonProjectId}, schema ${claimed.schemaVersion ?? 'unknown'})`
    );

    // Inline personalize only when the slot is fully migrated to the bundled
    // latest — a stale slot must go through the workflow's delta-applier
    // before user traffic hits it, so those callers keep the (short) wait.
    let ready = false;
    if (latestSchemaVersion && claimed.schemaVersion === latestSchemaVersion) {
      try {
        await this.personalizeWarmSlot(masterDb, claimed.databaseUrl, workspaceId, initialMember, selectedApps);
        ready = true;
      } catch (personalizeErr) {
        console.warn(`[Provisioning] Inline personalize failed for ${workspaceId}; falling back to workflow:`, personalizeErr);
      }
    }

    const workflowResult = await this.triggerProvisioningWorkflow(
      workspaceId, claimed.databaseUrl, workspaceName, initialMember, selectedApps, slug, seedSampleData,
    );
    if (!workflowResult.success) {
      console.warn(`[Provisioning] Could not trigger provisioning workflow: ${workflowResult.error}`);
    }

    return {
      success: true,
      workspaceId,
      neonProjectId: claimed.neonProjectId,
      neonDatabaseName: claimed.databaseName,
      neonBranchId: claimed.neonBranchId || '',
      neonRoleName: claimed.roleName,
      isDedicated: claimed.kind !== 'shared',
      connectionUri: claimed.databaseUrl,
      ready,
    };
  }

  /**
   * Synchronous personalization of a pre-migrated warm database: OWNER member
   * and selected apps in the tenant DB, then connection URL + ready flags on
   * the master row. Mirrors the workflow's insert-initial-member /
   * install-apps / mark-provisioned steps, which stay idempotent no-ops when
   * the workflow re-runs them afterwards.
   */
  private async personalizeWarmSlot(
    masterDb: any,
    databaseUrl: string,
    workspaceId: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
  ): Promise<void> {
    const tenantDb = drizzleNeonHttp({ client: neon(databaseUrl) });

    if (initialMember) {
      const [existing] = await tenantDb
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, initialMember.userId))
        .limit(1);

      if (!existing) {
        await tenantDb.insert(workspaceMembers).values({
          id: generateId('mbr'),
          userId: initialMember.userId,
          email: initialMember.email,
          name: initialMember.name,
          picture: initialMember.picture,
          role: 'OWNER',
          status: 'ACTIVE',
          clerkMembershipId: initialMember.clerkMembershipId,
          acceptedAt: new Date(),
        });
      }
    }

    if (selectedApps && selectedApps.length > 0) {
      const now = new Date();
      for (const appCode of selectedApps) {
        await tenantDb.insert(workspaceInstalledApps).values({
          id: generateId('app'),
          appCode,
          isActive: true,
          displayOrder: 0,
          installedAt: now,
          installedBy: initialMember?.userId,
        }).onConflictDoNothing();
      }
    }

    let storedUrl = databaseUrl;
    if (this.env.DATABASE_ENCRYPTION_KEY || this.env.DATABASE_ENCRYPTION_KEY_V2) {
      try {
        storedUrl = await encryptField(databaseUrl, keyringFromEnv(this.env));
      } catch (encryptErr) {
        console.warn('[Provisioning] Failed to encrypt connection string, storing plaintext:', encryptErr);
      }
    }

    await masterDb
      .update(workspaces)
      .set({
        databaseUrl: storedUrl,
        databaseProvisionedAt: new Date(),
        provisioningStatus: 'ready',
        provisioningError: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId));

    console.log(`[Provisioning] Workspace ${workspaceId} personalized inline and marked ready`);
  }

  /**
   * Provision database for a workspace based on plan.
   * Tries to claim a pre-migrated database from the pool first.
   * Falls back to creating a new Neon project if pool is empty or stale.
   *
   * @param masterDb - Master database connection
   * @param workspaceId - Internal workspace ID
   * @param workspaceName - Workspace display name
   * @param planSlug - Plan slug (free, business, scale, enterprise)
   * @param initialMember - Initial member to insert after migration (typically the creator)
   * @param latestSchemaVersion - Latest migration tag for pool schema version matching
   */
  async provisionForWorkspace(
    masterDb: any,
    workspaceId: string,
    workspaceName: string,
    planSlug: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
    slug?: string,
    latestSchemaVersion?: string,
    seedSampleData?: boolean,
  ): Promise<ProvisioningResult> {
    // Check if workspace already has a database
    const [workspace] = await masterDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace) {
      return {
        success: false,
        workspaceId,
        neonProjectId: '',
        neonDatabaseName: '',
        neonBranchId: '',
        isDedicated: false,
        error: 'Workspace not found',
      };
    }

    // A database already exists for this workspace.
    if (workspace.neonProjectId && workspace.neonRoleName) {
      // If provisioning never completed (databaseProvisionedAt is still null),
      // the workflow died or was never triggered. Re-trigger it — its steps are
      // idempotent — instead of leaving the workspace permanently stuck. This is
      // the recovery path that the /onboarding/retry endpoint relies on.
      if (!workspace.databaseProvisionedAt) {
        const databaseUrl = await this.resolveConnectionUri(workspace);
        if (databaseUrl) {
          const retrigger = await this.triggerProvisioningWorkflow(
            workspaceId, databaseUrl, workspaceName, initialMember, selectedApps, slug, seedSampleData,
          );
          if (!retrigger.success) {
            console.warn(`[Provisioning] Could not re-trigger workflow for ${workspaceId}: ${retrigger.error}`);
          }
        } else {
          console.warn(`[Provisioning] Cannot resolve connection URI to re-trigger workspace ${workspaceId}`);
        }
      }

      return {
        success: true,
        workspaceId,
        neonProjectId: workspace.neonProjectId,
        neonDatabaseName: workspace.neonDatabaseName || 'neondb',
        neonBranchId: workspace.neonBranchId || '',
        neonRoleName: workspace.neonRoleName || undefined,
        isDedicated: true,
      };
    }

    // Entry tiers (legacy free + Starter, which is where every new workspace
    // begins its 14-day trial): NEVER get a dedicated Neon project — a project
    // per trial/entry workspace is prohibitively expensive at scale
    // (project-count ceiling + compute fan-out). Instant path first: claim a
    // warm, pre-migrated database inside a shared shard; otherwise create one
    // on-demand in a shard (creating a new shard if every shard is full). There
    // is deliberately NO dedicated-project fallback: if the shared path fails
    // the workspace is marked 'failed' and the user retries via onboarding.
    if (planSlug === 'free' || planSlug === 'business') {
      if (latestSchemaVersion) {
        const warmShared = await this.claimFromPool(masterDb, workspaceId, 'shared', this.defaultRegion);
        if (warmShared) {
          return this.activateWarmSlot(
            masterDb, warmShared, workspaceId, workspaceName, latestSchemaVersion,
            initialMember, selectedApps, slug, seedSampleData,
          );
        }
      }
      return this.provisionSharedDatabase(
        masterDb, workspaceId, workspaceName, initialMember, selectedApps, slug, seedSampleData,
      );
    }

    // Paid: claim a warm pre-migrated dedicated project from the pool first.
    if (latestSchemaVersion) {
      const warmDedicated = await this.claimFromPool(masterDb, workspaceId, 'dedicated', this.defaultRegion);
      if (warmDedicated) {
        return this.activateWarmSlot(
          masterDb, warmDedicated, workspaceId, workspaceName, latestSchemaVersion,
          initialMember, selectedApps, slug, seedSampleData,
        );
      }
    }

    // Pool empty or stale — create dedicated project on-demand
    return this.provisionDedicatedProject(masterDb, workspaceId, workspaceName, initialMember, selectedApps, slug, seedSampleData);
  }

  /**
   * Free tier: provision a database + role inside a SHARED Neon project.
   *
   * Reuses the `neonSharedProjects` capacity-tracking plumbing. The workspace
   * still gets its own Postgres database + role (so isolation, migrations, and
   * the provisioning workflow are identical to dedicated tenants) — it just
   * lives inside a project shared with other free tenants, which collapses the
   * Neon project count and amortizes compute across idle free workspaces.
   *
   * Distinguished from dedicated tenants by a non-null `workspaces.sharedProjectId`,
   * which is what `deleteWorkspaceDatabase` keys off for the drop-DB-and-role path.
   */
  async provisionSharedDatabase(
    masterDb: any,
    workspaceId: string,
    workspaceName: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
    slug?: string,
    seedSampleData?: boolean,
  ): Promise<ProvisioningResult> {
    const region = this.defaultRegion;

    const emptyResult = (error: string): ProvisioningResult => ({
      success: false,
      workspaceId,
      neonProjectId: '',
      neonDatabaseName: '',
      neonBranchId: '',
      isDedicated: false,
      error,
    });

    // 1. Atomically claim capacity on an active shard (creating one if needed).
    const shard = await this.claimSharedProject(masterDb, region);
    if (!shard || !shard.mainBranchId) {
      return emptyResult('No shared-project capacity available');
    }

    // Postgres identifiers: lowercase, alnum + underscore only.
    const sanitize = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const dbName = sanitize(`ws_${workspaceId}`);
    const roleName = sanitize(`role_${workspaceId}`);

    try {
      // 2. Create the role first (it must exist to own the database), then the DB.
      //    Both calls are applied asynchronously on the compute — we MUST wait for
      //    the operations to settle before connecting, otherwise the provisioning
      //    workflow can hit "role/database does not exist" when it opens the URI.
      const roleRes = await this.neonClient.createRole(shard.neonProjectId, shard.mainBranchId, roleName);
      await this.neonClient.waitForOperations(shard.neonProjectId, roleRes.operations);

      const dbRes = await this.neonClient.createDatabase(shard.neonProjectId, shard.mainBranchId, dbName, roleName);
      await this.neonClient.waitForOperations(shard.neonProjectId, dbRes.operations);

      const connectionUri = await this.neonClient.getConnectionUri(
        shard.neonProjectId,
        shard.mainBranchId,
        dbName,
        roleName,
        { pooled: true },
      );

      // 3. Claim the workspace ATOMICALLY — only the first caller to set
      //    neon_project_id wins. Under the webhook+onboard double-trigger this
      //    guarantees a single database per workspace instead of two orphans.
      const claimed = await masterDb
        .update(workspaces)
        .set({
          neonProjectId: shard.neonProjectId,
          neonDatabaseName: dbName,
          neonBranchId: shard.mainBranchId,
          neonRoleName: roleName,
          neonRegion: region,
          sharedProjectId: shard.id,
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.neonProjectId)))
        .returning({ id: workspaces.id });

      if (claimed.length === 0) {
        // Another provisioning call already assigned a database to this workspace.
        // Release the resources we just created and defer to the winner.
        console.log(`[Provisioning] Lost provisioning race for ${workspaceId}; releasing shared resources`);
        await this.releaseSharedSlot(masterDb, shard, dbName, roleName);

        const [winner] = await masterDb.select().from(workspaces).where(eq(workspaces.id, workspaceId));
        return {
          success: true,
          workspaceId,
          neonProjectId: winner?.neonProjectId || '',
          neonDatabaseName: winner?.neonDatabaseName || 'neondb',
          neonBranchId: winner?.neonBranchId || '',
          neonRoleName: winner?.neonRoleName || undefined,
          isDedicated: !winner?.sharedProjectId,
        };
      }

      console.log(
        `[Provisioning] Workspace ${workspaceId} assigned shared database ${dbName} ` +
        `in project ${shard.neonProjectId} (shard ${shard.id}, ${region})`
      );

      // 4. Same async provisioning workflow as everyone else. Its apply-migrations
      //    step brings the fresh database fully up to the bundled schema before the
      //    onboarding UI is allowed to admit the user (it gates on databaseProvisionedAt).
      const workflowResult = await this.triggerProvisioningWorkflow(
        workspaceId, connectionUri, workspaceName, initialMember, selectedApps, slug, seedSampleData,
      );
      if (!workflowResult.success) {
        console.warn(`[Provisioning] Could not trigger provisioning workflow: ${workflowResult.error}`);
      }

      return {
        success: true,
        workspaceId,
        neonProjectId: shard.neonProjectId,
        neonDatabaseName: dbName,
        neonBranchId: shard.mainBranchId,
        neonRoleName: roleName,
        isDedicated: false,
        connectionUri,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Provisioning] Failed to provision shared database for ${workspaceId}:`, error);

      // Release the capacity slot we reserved and clean up any partially-created
      // role/database so the shard count stays honest. Best-effort — the caller
      // surfaces the failure so the user can retry (free tier deliberately has
      // no dedicated-project fallback).
      await this.releaseSharedSlot(masterDb, shard, dbName, roleName);

      return emptyResult(message);
    }
  }

  /**
   * Release a previously-reserved shared-project slot: decrement the shard's
   * database count (and re-open it if it was 'full'), then drop the tenant
   * database + role. Used on provisioning failure and on losing the claim race.
   * Every step is best-effort — a leftover orphan is acceptable and self-heals
   * on the next successful claim/decrement.
   */
  private async releaseSharedSlot(
    masterDb: any,
    shard: NeonSharedProject,
    dbName: string,
    roleName: string,
  ): Promise<void> {
    await this.releaseShardCapacity(masterDb, shard.id);
    if (shard.mainBranchId) {
      await this.neonClient.deleteDatabase(shard.neonProjectId, shard.mainBranchId, dbName).catch(() => {});
      await this.neonClient.deleteRole(shard.neonProjectId, shard.mainBranchId, roleName).catch(() => {});
    }
  }

  /**
   * Atomically reserve a capacity slot on an active shared project for the given
   * region, creating a fresh shard if none has room. Increments `databaseCount`
   * (flipping to 'full' at capacity) in a single statement so concurrent
   * signups can't overfill a shard past `maxDatabases`.
   */
  private async claimSharedProject(masterDb: any, region: string): Promise<NeonSharedProject | null> {
    try {
      const result = await masterDb.execute(
        sql`UPDATE neon_shared_projects
            SET database_count = database_count + 1,
                status = CASE WHEN database_count + 1 >= max_databases THEN 'full' ELSE status END,
                updated_at = NOW()
            WHERE id = (
              SELECT id FROM neon_shared_projects
              WHERE status = 'active'
                AND region = ${region}
                AND database_count < max_databases
              ORDER BY database_count ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            RETURNING *`
      );

      const row = result.rows?.[0] || result[0];
      if (row) {
        console.log(`[Provisioning] Claimed slot on shared project ${row.neon_project_id} (shard ${row.id}, count now ${row.database_count})`);
        return this.mapSharedProject(row);
      }
    } catch (error) {
      console.warn('[Provisioning] Shared-project claim failed, will try to create a new shard:', error);
    }

    // No shard with room → create a new one (reserving this caller's slot).
    return this.createSharedProject(masterDb, region);
  }

  /**
   * Create a brand-new shared Neon project and its tracking row, with the first
   * capacity slot already reserved (database_count = 1). The shared compute uses
   * a higher autoscaling ceiling than a dedicated free tenant would, since it
   * serves many databases.
   */
  private async createSharedProject(masterDb: any, region: string): Promise<NeonSharedProject | null> {
    const id = generateId('nsp');
    const projectName = `weldsuite-shared-${region}-${id.slice(-8)}`;

    try {
      const response = await this.neonClient.createProject(projectName, region, {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 2,
      });

      const project = response.project;
      const branch = response.branch;
      const endpoint = response.endpoints[0];
      const adminRole = response.roles.find(r => !r.protected);

      if (!branch || !endpoint) {
        throw new Error('Shared project creation did not return expected resources');
      }

      const [inserted] = await masterDb
        .insert(neonSharedProjects)
        .values({
          id,
          neonProjectId: project.id,
          neonProjectName: projectName,
          region,
          mainBranchId: branch.id,
          connectionHost: endpoint.host,
          adminRole: adminRole?.name,
          databaseCount: 1, // reserve this caller's slot
          maxDatabases: 100, // conservative; bounded by shared compute connections, not Neon's 500 ceiling
          status: 'active',
        })
        .returning();

      console.log(`[Provisioning] Created shared project ${project.id} (shard ${id}, region ${region})`);
      return inserted as NeonSharedProject;
    } catch (error) {
      console.error(`[Provisioning] Failed to create shared project in ${region}:`, error);
      return null;
    }
  }

  /** Map a raw neon_shared_projects row (snake_case) to the typed shape. */
  private mapSharedProject(row: any): NeonSharedProject {
    return {
      id: row.id,
      neonProjectId: row.neon_project_id,
      neonProjectName: row.neon_project_name,
      region: row.region,
      mainBranchId: row.main_branch_id,
      connectionHost: row.connection_host,
      connectionPort: row.connection_port,
      adminRole: row.admin_role,
      adminPasswordEncrypted: row.admin_password_encrypted,
      databaseCount: row.database_count,
      maxDatabases: row.max_databases,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as NeonSharedProject;
  }

  /**
   * Provision a dedicated Neon project for paid customers
   */
  async provisionDedicatedProject(
    masterDb: any,
    workspaceId: string,
    workspaceName: string,
    initialMember?: InitialMember,
    selectedApps?: string[],
    slug?: string,
    seedSampleData?: boolean,
  ): Promise<ProvisioningResult> {
    const projectName = `weldsuite-${workspaceId.substring(0, 20)}`;

    try {
      // Create new Neon project
      const response = await this.neonClient.createProject(
        projectName,
        this.defaultRegion,
        {
          autoscalingLimitMinCu: 0.25,
          autoscalingLimitMaxCu: 0.5,
        }
      );

      const project = response.project;
      const branch = response.branch;
      const endpoint = response.endpoints[0];
      const defaultRole = response.roles.find(r => !r.protected);
      const defaultDatabase = response.databases.find(d => d.name === 'neondb');

      if (!defaultRole || !endpoint) {
        throw new Error('Project creation did not return expected resources');
      }

      const databaseName = defaultDatabase?.name || 'neondb';
      const roleName = defaultRole.name;

      // Use connection_uris from createProject response directly (saves 2 API calls)
      let connectionUri: string;
      const connUri = response.connection_uris?.[0];
      if (connUri) {
        const host = connUri.connection_parameters.pooler_host || connUri.connection_parameters.host;
        connectionUri = `postgresql://${encodeURIComponent(connUri.connection_parameters.role)}:${encodeURIComponent(connUri.connection_parameters.password)}@${host}/${connUri.connection_parameters.database}?sslmode=require`;
      } else {
        connectionUri = await this.neonClient.getConnectionUri(
          project.id,
          branch.id,
          databaseName,
          roleName,
          { pooled: true }
        );
      }

      // Update workspace record (no databaseUrl — resolved on-demand via Neon API)
      // NOTE: databaseProvisionedAt is NOT set here — it's set by the Cloudflare
      // Workflow after schema migrations complete successfully.
      await masterDb
        .update(workspaces)
        .set({
          neonProjectId: project.id,
          neonDatabaseName: databaseName,
          neonBranchId: branch.id,
          neonRoleName: roleName,
          neonRegion: this.defaultRegion,
          sharedProjectId: null,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));

      console.log(`[Provisioning] Created dedicated project ${project.id} for workspace ${workspaceId}`);

      // Trigger async provisioning via Cloudflare Workflow
      // The workflow applies Drizzle migrations, inserts initial member,
      // seeds data, sets up billing, and marks the workspace as provisioned.
      const workflowResult = await this.triggerProvisioningWorkflow(
        workspaceId, connectionUri, workspaceName, initialMember, selectedApps, slug, seedSampleData
      );
      if (!workflowResult.success) {
        console.warn(`[Provisioning] Could not trigger provisioning workflow: ${workflowResult.error}`);
        // Don't fail provisioning - workflow can be triggered manually later
      }

      return {
        success: true,
        workspaceId,
        neonProjectId: project.id,
        neonDatabaseName: databaseName,
        neonBranchId: branch.id,
        neonRoleName: roleName,
        isDedicated: true,
        connectionUri,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Provisioning] Failed to create dedicated project for ${workspaceId}:`, error);

      return {
        success: false,
        workspaceId,
        neonProjectId: '',
        neonDatabaseName: '',
        neonBranchId: '',
        isDedicated: true,
        error: message,
      };
    }
  }

  /**
   * Create the Neon-side resources for a warm SHARED pool slot: reserve
   * capacity on a shard (creating a new shard if needed), then create the
   * role + database and build the pooled connection URI. The caller (refill
   * workflow) runs migrations/seeds against the returned URI and inserts the
   * `database_pool` row once the slot is fully ready — so a crash in between
   * leaves at most an orphaned database, never a claimable half-ready slot.
   */
  async createWarmSharedSlotResources(masterDb: any): Promise<WarmSlotResources | null> {
    const shard = await this.claimShardForWarmSlot(masterDb);
    if (!shard) return null;

    const resources = await this.createWarmSharedSlotResourcesOnShard(shard);
    if (!resources) {
      await this.releaseShardCapacity(masterDb, shard.id);
      return null;
    }
    return resources;
  }

  /**
   * Atomically reserve one warm-slot capacity unit on a shard in the default
   * region (creating a fresh shard if every shard is full). The caller owns
   * the reservation: release it via `releaseShardCapacity` if slot creation
   * fails before a `database_pool` row exists.
   */
  async claimShardForWarmSlot(masterDb: any): Promise<NeonSharedProject | null> {
    const shard = await this.claimSharedProject(masterDb, this.defaultRegion);
    if (!shard || !shard.mainBranchId) {
      console.warn('[Provisioning] No shared-project capacity available for warm slot');
      return null;
    }
    return shard;
  }

  /**
   * Return a previously claimed (but unused) shard capacity unit: decrement
   * the count and re-open the shard if the claim had flipped it to 'full'.
   */
  async releaseShardCapacity(masterDb: any, shardId: string): Promise<void> {
    try {
      await masterDb
        .update(neonSharedProjects)
        .set({
          databaseCount: sql`GREATEST(${neonSharedProjects.databaseCount} - 1, 0)`,
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(neonSharedProjects.id, shardId));
    } catch (error) {
      console.warn(`[Provisioning] Failed to release capacity on shard ${shardId}:`, error);
    }
  }

  /**
   * Legacy warm-slot creation on an already-claimed shard: API-create the
   * role + empty database. The caller must run the full migration journal
   * before inserting the pool row, and must release the shard capacity if
   * this returns null. Kept as the fallback for shards where the golden
   * template path is unavailable.
   */
  async createWarmSharedSlotResourcesOnShard(shard: NeonSharedProject): Promise<WarmSlotResources | null> {
    if (!shard.mainBranchId) return null;
    const poolId = generateId('dbp');
    const sanitize = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const dbName = sanitize(`ws_pool_${poolId}`);
    const roleName = sanitize(`role_pool_${poolId}`);

    try {
      const roleRes = await this.neonClient.createRole(shard.neonProjectId, shard.mainBranchId, roleName);
      await this.neonClient.waitForOperations(shard.neonProjectId, roleRes.operations);

      const dbRes = await this.neonClient.createDatabase(shard.neonProjectId, shard.mainBranchId, dbName, roleName);
      await this.neonClient.waitForOperations(shard.neonProjectId, dbRes.operations);

      const databaseUrl = await this.neonClient.getConnectionUri(
        shard.neonProjectId,
        shard.mainBranchId,
        dbName,
        roleName,
        { pooled: true },
      );

      console.log(`[Provisioning] Created warm shared slot ${poolId} (db ${dbName} in shard ${shard.id})`);
      return {
        poolId,
        kind: 'shared',
        neonProjectId: shard.neonProjectId,
        neonBranchId: shard.mainBranchId,
        connectionHost: shard.connectionHost ?? undefined,
        databaseName: dbName,
        roleName,
        databaseUrl,
        sharedProjectId: shard.id,
        region: shard.region || this.defaultRegion,
      };
    } catch (error) {
      console.error('[Provisioning] Failed to create warm shared slot resources:', error);
      if (shard.mainBranchId) {
        await this.neonClient.deleteDatabase(shard.neonProjectId, shard.mainBranchId, dbName).catch(() => {});
        await this.neonClient.deleteRole(shard.neonProjectId, shard.mainBranchId, roleName).catch(() => {});
      }
      return null;
    }
  }

  /**
   * Direct (non-pooled) admin connection URI for a shard database. Control
   * operations (CREATE/DROP DATABASE, role management) go through this.
   * Returns null when the shard predates admin-role tracking — callers fall
   * back to the legacy journal-replay path.
   */
  private async shardAdminUrl(shard: NeonSharedProject, database = 'neondb'): Promise<string | null> {
    if (!shard.adminRole || !shard.mainBranchId) return null;
    try {
      return await this.neonClient.getConnectionUri(
        shard.neonProjectId,
        shard.mainBranchId,
        database,
        shard.adminRole,
        { pooled: false },
      );
    } catch (error) {
      console.warn(`[Provisioning] Could not resolve admin URI for shard ${shard.id}:`, error);
      return null;
    }
  }

  /**
   * Schema version of the shard's golden template, read from
   * COMMENT ON DATABASE via the shared pg_shdescription catalog — deliberately
   * without connecting to the golden database (it is sealed with
   * ALLOW_CONNECTIONS false so template copies never race a live connection).
   * Returns null when the template is missing or the shard lacks admin access.
   */
  async getGoldenSchemaVersion(shard: NeonSharedProject): Promise<string | null> {
    const adminUrl = await this.shardAdminUrl(shard);
    if (!adminUrl) return null;
    try {
      const result = await neon(adminUrl).query(
        `SELECT sd.description AS version
         FROM pg_shdescription sd
         JOIN pg_database d ON d.oid = sd.objoid
         WHERE d.datname = $1`,
        [GOLDEN_TEMPLATE_DB],
      );
      return rowsOf(result)[0]?.version ?? null;
    } catch (error) {
      console.warn(`[Provisioning] Golden version check failed for shard ${shard.id}:`, error);
      return null;
    }
  }

  /**
   * Prepare the shard's golden template for (re-)migration: create the
   * database via the API if missing (API-created so the control plane tracks
   * it), ensure the NOLOGIN owner role + schema grants exist, and re-open
   * connections if the template was previously sealed. Returns the admin
   * connection URI to the golden database for the caller to run the migration
   * journal against, or null when the shard can't support the template path.
   */
  async openGoldenForMigration(shard: NeonSharedProject): Promise<string | null> {
    const adminUrl = await this.shardAdminUrl(shard);
    if (!adminUrl || !shard.mainBranchId || !shard.adminRole) return null;

    try {
      const admin = neon(adminUrl);

      const { databases } = await this.neonClient.listDatabases(shard.neonProjectId, shard.mainBranchId);
      if (!databases.some((d) => d.name === GOLDEN_TEMPLATE_DB)) {
        const dbRes = await this.neonClient.createDatabase(
          shard.neonProjectId, shard.mainBranchId, GOLDEN_TEMPLATE_DB, shard.adminRole,
        );
        await this.neonClient.waitForOperations(shard.neonProjectId, dbRes.operations);
      } else {
        await admin.query(`ALTER DATABASE ${GOLDEN_TEMPLATE_DB} ALLOW_CONNECTIONS true`);
      }

      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GOLDEN_TEMPLATE_ROLE}') THEN
             CREATE ROLE ${GOLDEN_TEMPLATE_ROLE} NOLOGIN;
           END IF;
         END $$`,
      );
      await admin.query(`GRANT ${GOLDEN_TEMPLATE_ROLE} TO CURRENT_USER`);

      const goldenUrl = swapDatabase(adminUrl, GOLDEN_TEMPLATE_DB);
      // ALTER ... OWNER TO requires the new owner to hold CREATE on the schema.
      await neon(goldenUrl).query(`GRANT USAGE, CREATE ON SCHEMA public TO ${GOLDEN_TEMPLATE_ROLE}`);

      console.log(`[Provisioning] Golden template open for migration on shard ${shard.id}`);
      return goldenUrl;
    } catch (error) {
      console.error(`[Provisioning] Failed to open golden template on shard ${shard.id}:`, error);
      return null;
    }
  }

  /**
   * Seal the golden template after migration: hand its objects to the NOLOGIN
   * owner role, stamp the schema version into COMMENT ON DATABASE, and lock
   * the database (IS_TEMPLATE + ALLOW_CONNECTIONS false) so subsequent
   * template copies succeed first-attempt with no connection contention.
   */
  async sealGoldenTemplate(shard: NeonSharedProject, schemaVersion: string): Promise<boolean> {
    const adminUrl = await this.shardAdminUrl(shard);
    if (!adminUrl) return false;
    try {
      await neon(swapDatabase(adminUrl, GOLDEN_TEMPLATE_DB)).query(TRANSFER_GOLDEN_OWNERSHIP_SQL);

      const admin = neon(adminUrl);
      await admin.query(`COMMENT ON DATABASE ${GOLDEN_TEMPLATE_DB} IS '${schemaVersion.replace(/'/g, "''")}'`);
      await admin.query(`ALTER DATABASE ${GOLDEN_TEMPLATE_DB} IS_TEMPLATE true`);
      await admin.query(`ALTER DATABASE ${GOLDEN_TEMPLATE_DB} ALLOW_CONNECTIONS false`);

      console.log(`[Provisioning] Golden template sealed at ${schemaVersion} on shard ${shard.id}`);
      return true;
    } catch (error) {
      console.error(`[Provisioning] Failed to seal golden template on shard ${shard.id}:`, error);
      return false;
    }
  }

  /**
   * Create a warm shared slot by cloning the shard's sealed golden template —
   * a storage-level copy that replaces the full journal replay. The slot role
   * is created via SQL (not the API) because on PG16+ only the creator gets
   * ADMIN OPTION on a role, which the ownership handoff below requires; the
   * Neon control plane syncs SQL-created roles/databases, so existing
   * API-based cleanup paths still work. On failure, drops its own leftovers
   * and returns null — releasing the shard capacity stays the caller's job.
   */
  async createWarmSharedSlotFromTemplate(shard: NeonSharedProject): Promise<WarmSlotResources | null> {
    if (!shard.mainBranchId || !shard.connectionHost) return null;
    const adminUrl = await this.shardAdminUrl(shard);
    if (!adminUrl) return null;

    const poolId = generateId('dbp');
    const sanitize = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const dbName = sanitize(`ws_pool_${poolId}`);
    const roleName = sanitize(`role_pool_${poolId}`);
    const admin = neon(adminUrl);

    try {
      // Idempotent under workflow-step retries.
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${roleName}`);

      const password = generatePassword();
      await admin.query(`CREATE ROLE ${roleName} WITH LOGIN PASSWORD '${password}'`);
      // Membership lets the admin ALTER DATABASE OWNER + REASSIGN below.
      await admin.query(`GRANT ${roleName} TO CURRENT_USER`);

      // Golden is sealed (no connections allowed), so the copy normally lands
      // first-attempt; the sweep+retry covers a concurrent catch-up window.
      for (let attempt = 1; ; attempt++) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = '${GOLDEN_TEMPLATE_DB}' AND pid <> pg_backend_pid()`,
        );
        try {
          await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${GOLDEN_TEMPLATE_DB}`);
          break;
        } catch (copyError) {
          const message = copyError instanceof Error ? copyError.message : String(copyError);
          if (attempt >= 4 || !/being accessed by other users/.test(message)) throw copyError;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }

      await admin.query(`ALTER DATABASE ${dbName} OWNER TO ${roleName}`);
      // Safe blanket reassign: GOLDEN_TEMPLATE_ROLE owns no cluster-shared
      // objects, so this only touches the copied objects in the slot database.
      await neon(swapDatabase(adminUrl, dbName)).query(`REASSIGN OWNED BY ${GOLDEN_TEMPLATE_ROLE} TO ${roleName}`);
      await admin.query(`REVOKE ${roleName} FROM CURRENT_USER`);

      const databaseUrl =
        `postgresql://${roleName}:${password}@${poolerHostOf(shard.connectionHost)}/${dbName}?sslmode=require`;

      console.log(`[Provisioning] Cloned warm shared slot ${poolId} from golden template (shard ${shard.id})`);
      return {
        poolId,
        kind: 'shared',
        neonProjectId: shard.neonProjectId,
        neonBranchId: shard.mainBranchId,
        connectionHost: shard.connectionHost,
        databaseName: dbName,
        roleName,
        databaseUrl,
        sharedProjectId: shard.id,
        region: shard.region || this.defaultRegion,
        preMigrated: true,
      };
    } catch (error) {
      console.error(`[Provisioning] Template clone failed on shard ${shard.id}:`, error);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
      return null;
    }
  }

  /**
   * Create the Neon-side resources for a warm DEDICATED pool slot: a whole
   * pre-created project, named `weldsuite-pool-*` so the pool cleanup tooling
   * recognizes it. Same contract as the shared variant — the caller migrates
   * and inserts the pool row afterwards.
   */
  async createWarmDedicatedProjectResources(): Promise<WarmSlotResources | null> {
    const poolId = generateId('dbp');
    const projectName = `weldsuite-pool-${poolId.slice(-12)}`;

    try {
      const response = await this.neonClient.createProject(projectName, this.defaultRegion, {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 0.5,
      });

      const project = response.project;
      const branch = response.branch;
      const endpoint = response.endpoints[0];
      const defaultRole = response.roles.find(r => !r.protected);
      const defaultDatabase = response.databases.find(d => d.name === 'neondb');

      if (!defaultRole || !endpoint || !branch) {
        throw new Error('Pool project creation did not return expected resources');
      }

      const databaseName = defaultDatabase?.name || 'neondb';
      const roleName = defaultRole.name;

      let databaseUrl: string;
      const connUri = response.connection_uris?.[0];
      if (connUri) {
        const host = connUri.connection_parameters.pooler_host || connUri.connection_parameters.host;
        databaseUrl = `postgresql://${encodeURIComponent(connUri.connection_parameters.role)}:${encodeURIComponent(connUri.connection_parameters.password)}@${host}/${connUri.connection_parameters.database}?sslmode=require`;
      } else {
        databaseUrl = await this.neonClient.getConnectionUri(
          project.id, branch.id, databaseName, roleName, { pooled: true },
        );
      }

      console.log(`[Provisioning] Created warm dedicated pool project ${project.id} (${projectName})`);
      return {
        poolId,
        kind: 'dedicated',
        neonProjectId: project.id,
        neonBranchId: branch.id,
        connectionHost: endpoint.host,
        databaseName,
        roleName,
        databaseUrl,
        region: this.defaultRegion,
      };
    } catch (error) {
      console.error('[Provisioning] Failed to create warm dedicated pool project:', error);
      return null;
    }
  }

  /**
   * Best-effort cleanup of warm-slot Neon resources after a refill failure
   * (e.g. migrations errored). Shared slots drop the db + role and release
   * the shard capacity; dedicated slots delete the whole pool project.
   */
  async releaseWarmSlotResources(masterDb: any, res: WarmSlotResources): Promise<void> {
    if (res.kind === 'shared') {
      if (res.sharedProjectId) {
        try {
          const [shard] = await masterDb
            .select()
            .from(neonSharedProjects)
            .where(eq(neonSharedProjects.id, res.sharedProjectId))
            .limit(1);
          if (shard) {
            await this.releaseSharedSlot(masterDb, shard as NeonSharedProject, res.databaseName, res.roleName);
            return;
          }
        } catch (err) {
          console.warn('[Provisioning] Failed to release warm shared slot resources:', err);
        }
      }
      await this.neonClient.deleteDatabase(res.neonProjectId, res.neonBranchId, res.databaseName).catch(() => {});
      await this.neonClient.deleteRole(res.neonProjectId, res.neonBranchId, res.roleName).catch(() => {});
    } else {
      await this.neonClient.deleteProject(res.neonProjectId).catch(() => {});
    }
  }

  /**
   * Delete database for a workspace (workspace deletion)
   */
  async deleteWorkspaceDatabase(
    masterDb: any,
    workspaceId: string
  ): Promise<{ success: boolean; error?: string }> {
    const [workspace] = await masterDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (!workspace || !workspace.neonProjectId) {
      return { success: true }; // Nothing to delete
    }

    try {
      if (workspace.sharedProjectId) {
        // Shared database — delete database and role within the shared project
        if (workspace.neonDatabaseName && workspace.neonBranchId) {
          await this.neonClient.deleteDatabase(
            workspace.neonProjectId,
            workspace.neonBranchId,
            workspace.neonDatabaseName
          );
        }

        if (workspace.neonRoleName && workspace.neonBranchId) {
          await this.neonClient.deleteRole(
            workspace.neonProjectId,
            workspace.neonBranchId,
            workspace.neonRoleName
          );
        }

        // Decrement shared project count
        await masterDb
          .update(neonSharedProjects)
          .set({
            databaseCount: sql`${neonSharedProjects.databaseCount} - 1`,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(neonSharedProjects.id, workspace.sharedProjectId));
      } else {
        // Dedicated project — delete entire Neon project
        await this.neonClient.deleteProject(workspace.neonProjectId);
      }

      // Clear workspace database fields
      await masterDb
        .update(workspaces)
        .set({
          neonProjectId: null,
          neonDatabaseName: null,
          neonBranchId: null,
          neonRoleName: null,
          sharedProjectId: null,
          databaseProvisionedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));

      // Best-effort: remove the pool row that tracked this workspace's warm
      // slot so stale 'assigned' entries don't accumulate.
      try {
        await masterDb
          .delete(databasePool)
          .where(eq(databasePool.assignedWorkspaceId, workspaceId));
      } catch (poolErr) {
        console.warn(`[Provisioning] Failed to delete pool row for ${workspaceId}:`, poolErr);
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Provisioning] Failed to delete database for ${workspaceId}:`, error);
      return { success: false, error: message };
    }
  }

}

/**
 * Create provisioning service from environment
 */
export function createProvisioningService(env: ProvisioningEnv): DatabaseProvisioningService {
  return new DatabaseProvisioningService(env);
}
