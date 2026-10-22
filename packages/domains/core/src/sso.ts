/**
 * Enterprise SSO, the parts app-api (configuration) and billing-worker
 * (add-on webhooks, admin console, hourly sweep) share: the workspace's SSO
 * state, its entitlement, and keeping the Clerk SAML connection's `active`
 * flag equal to `enabled && entitled && domain verified`.
 *
 * Clerk is reached through the slice of `@clerk/backend`'s client below, so
 * callers pass `createClerkClient({ secretKey })` and tests pass a fake.
 * The two workers use different Drizzle drivers, so the db handle is typed as
 * the driver-agnostic `PgDatabase` (see partners/types.ts).
 */

import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { SsoProvider, WorkspaceSso } from '@weldsuite/db/schema/master';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  planIncludesSso,
  resolveSsoEntitlement,
  type SsoEntitlement,
} from '@weldsuite/app-api-client/schemas/sso';

const { workspaces, workspaceSso, plans } = masterSchema;

export type SsoDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// ============================================================================
// Clerk
// ============================================================================

/** A Clerk SAML connection, as `@clerk/backend` returns it. */
export interface ClerkSamlConnection {
  id: string;
  domain: string;
  organizationId: string | null;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  idpCertificate: string | null;
  idpMetadataUrl: string | null;
  idpMetadata: string | null;
  acsUrl: string;
  spEntityId: string;
  spMetadataUrl: string;
  active: boolean;
  provider: string;
  userCount: number;
}

export interface ClerkSamlConnectionParams {
  name?: string;
  provider?: SsoProvider;
  domain?: string;
  organizationId?: string;
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertificate?: string;
  idpMetadataUrl?: string;
  idpMetadata?: string;
  active?: boolean;
}

/** The slice of `@clerk/backend`'s `ClerkClient` SSO needs. */
export interface SsoClerkClient {
  samlConnections: {
    createSamlConnection(
      params: ClerkSamlConnectionParams & { name: string; provider: SsoProvider; domain: string },
    ): Promise<ClerkSamlConnection>;
    getSamlConnection(id: string): Promise<ClerkSamlConnection>;
    updateSamlConnection(id: string, params?: ClerkSamlConnectionParams): Promise<ClerkSamlConnection>;
    deleteSamlConnection(id: string): Promise<unknown>;
  };
}

/** Clerk's `ClerkAPIResponseError` carries the HTTP status. */
export function clerkErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Clerk's own message for a refused request, e.g. "idp_metadata_url is invalid". */
export function clerkErrorMessage(err: unknown): string | null {
  const errors = (err as { errors?: Array<{ longMessage?: string; message?: string }> } | null)?.errors;
  const first = errors?.[0];
  return first?.longMessage ?? first?.message ?? null;
}

// ============================================================================
// State
// ============================================================================

export interface SsoWorkspace {
  id: string;
  clerkOrgId: string | null;
  name: string;
  planId: string | null;
  billingMode: 'direct' | 'partner';
  isActive: boolean;
  deletedAt: Date | null;
}

export interface SsoContext {
  workspace: SsoWorkspace;
  row: WorkspaceSso | null;
  planIncludesSso: boolean;
}

const workspaceColumns = {
  id: workspaces.id,
  clerkOrgId: workspaces.clerkOrgId,
  name: workspaces.name,
  planId: workspaces.planId,
  billingMode: workspaces.billingMode,
  isActive: workspaces.isActive,
  deletedAt: workspaces.deletedAt,
};

/** The workspace, its SSO row (if any) and whether its plan includes SSO. */
export async function loadSsoContext(
  db: SsoDb,
  by: { clerkOrgId: string } | { workspaceId: string },
): Promise<SsoContext | null> {
  const [workspace] = await db
    .select(workspaceColumns)
    .from(workspaces)
    .where('clerkOrgId' in by ? eq(workspaces.clerkOrgId, by.clerkOrgId) : eq(workspaces.id, by.workspaceId))
    .limit(1);
  if (!workspace) return null;

  const [row] = await db.select().from(workspaceSso).where(eq(workspaceSso.workspaceId, workspace.id)).limit(1);

  let includes = false;
  if (workspace.planId) {
    const [plan] = await db.select({ features: plans.features }).from(plans).where(eq(plans.id, workspace.planId)).limit(1);
    includes = planIncludesSso(plan?.features as Record<string, unknown> | null | undefined);
  }

  return { workspace, row: row ?? null, planIncludesSso: includes };
}

export function ssoEntitlement(ctx: SsoContext): SsoEntitlement {
  return resolveSsoEntitlement({
    planIncludesSso: ctx.planIncludesSso,
    workspaceActive: ctx.workspace.isActive && !ctx.workspace.deletedAt,
    priceOverrideCents: ctx.row?.priceOverrideCents,
    subscriptionStatus: ctx.row?.subscriptionStatus,
  });
}

/** The workspace's SSO row, created when it has none. */
export async function ensureSsoRow(db: SsoDb, workspace: Pick<SsoWorkspace, 'id' | 'clerkOrgId'>): Promise<WorkspaceSso> {
  if (!workspace.clerkOrgId) throw new Error(`Workspace ${workspace.id} has no Clerk organization`);
  await db
    .insert(workspaceSso)
    .values({ id: generateId('wsso'), workspaceId: workspace.id, clerkOrgId: workspace.clerkOrgId })
    .onConflictDoNothing({ target: workspaceSso.workspaceId });
  const [row] = await db.select().from(workspaceSso).where(eq(workspaceSso.workspaceId, workspace.id)).limit(1);
  if (!row) throw new Error(`Could not create the SSO row of workspace ${workspace.id}`);
  return row;
}

export async function updateSsoRow(
  db: SsoDb,
  rowId: string,
  patch: Partial<Omit<WorkspaceSso, 'id' | 'workspaceId' | 'createdAt'>>,
): Promise<WorkspaceSso> {
  const [row] = await db
    .update(workspaceSso)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workspaceSso.id, rowId))
    .returning();
  if (!row) throw new Error(`SSO row ${rowId} not found`);
  return row;
}

/** Fields that describe a connection; cleared together when it is removed. */
export const CLEARED_CONNECTION = {
  clerkConnectionId: null,
  provider: null,
  enabled: false,
  clerkActive: false,
  acsUrl: null,
  spEntityId: null,
  spMetadataUrl: null,
} as const;

// ============================================================================
// Reconcile
// ============================================================================

/** Whether Clerk should be sending the domain's users to the IdP. */
export function desiredClerkActive(ctx: SsoContext): boolean {
  const row = ctx.row;
  if (!row?.clerkConnectionId || !row.enabled || !row.domainVerifiedAt) return false;
  return ssoEntitlement(ctx).entitled;
}

export type ReconcileOutcome = 'unchanged' | 'activated' | 'deactivated' | 'connection_gone' | 'no_connection';

/**
 * Write `desiredClerkActive` to Clerk when it differs from what was last
 * written. A connection deleted in Clerk's dashboard is forgotten here. The
 * caller passes a context it just loaded, so a decision is never made on an
 * old read; whatever slips through is put right by the next call or the
 * hourly sweep.
 */
export async function reconcileSsoConnection(
  db: SsoDb,
  clerk: SsoClerkClient,
  ctx: SsoContext,
  actor: string,
): Promise<{ outcome: ReconcileOutcome; row: WorkspaceSso | null }> {
  const row = ctx.row;
  if (!row?.clerkConnectionId) return { outcome: 'no_connection', row };

  const desired = desiredClerkActive(ctx);
  if (desired === row.clerkActive) return { outcome: 'unchanged', row };

  try {
    await clerk.samlConnections.updateSamlConnection(row.clerkConnectionId, { active: desired });
  } catch (err) {
    if (clerkErrorStatus(err) !== 404) throw err;
    const cleared = await updateSsoRow(db, row.id, {
      ...CLEARED_CONNECTION,
      connectionUpdatedBy: actor,
      connectionUpdatedAt: new Date(),
    });
    return { outcome: 'connection_gone', row: cleared };
  }

  const saved = await updateSsoRow(db, row.id, { clerkActive: desired });
  return { outcome: desired ? 'activated' : 'deactivated', row: saved };
}

/** Delete the Clerk connection (a 404 counts as done) and forget it. */
export async function deleteSsoConnection(
  db: SsoDb,
  clerk: SsoClerkClient,
  row: WorkspaceSso,
  actor: string,
): Promise<WorkspaceSso> {
  if (row.clerkConnectionId) {
    try {
      await clerk.samlConnections.deleteSamlConnection(row.clerkConnectionId);
    } catch (err) {
      if (clerkErrorStatus(err) !== 404) throw err;
    }
  }
  return updateSsoRow(db, row.id, {
    ...CLEARED_CONNECTION,
    connectionUpdatedBy: actor,
    connectionUpdatedAt: new Date(),
  });
}
