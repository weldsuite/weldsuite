/**
 * Access to apps that are on request only (`app_catalog.requires_approval`,
 * WeldReach first) — master DB `workspace_app_access`.
 *
 * A workspace OWNER/ADMIN files a request from the app store, WeldSuite staff
 * approve or reject it in the admin console, and the module worker refuses
 * every request until the status is `approved` (`appAccessGate` in
 * `@weldsuite/worker-kit/app-access`). The catalog install endpoint refuses
 * such apps for the same reason.
 *
 * Pure functions — no Hono context. The workspace is resolved from the Clerk
 * org id (`workspaces.clerk_org_id`); `workspace_app_access.workspace_id` holds
 * the master `workspaces.id`, as in `workspace_licences`.
 *
 * Staff-only fields (`reviewNotes`, `reviewedBy`, the Stripe columns) never
 * leave this module: `toAppAccessView` is the only shape callers return.
 *
 * See docs/plans/weldreach.md ("Access and gating").
 */

import { and, eq, inArray } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  WELDREACH_APP_CODE,
  WELDREACH_DEFAULT_LIMITS,
  WELDREACH_TERMS,
  WELDREACH_TERMS_VERSION,
  type AppAccessRequestInput,
  type AppAccessStatus,
  type AppAccessView,
} from '@weldsuite/app-api-client/schemas/reach';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

const { workspaces, workspaceAppAccess, appCatalog } = masterSchema;

export type AppAccessRow = typeof workspaceAppAccess.$inferSelect;

/** Statuses in which a new request is refused: one is already in flight, or access is held. */
const OPEN_STATUSES: readonly AppAccessStatus[] = ['requested', 'approved', 'suspended'];

// ---------------------------------------------------------------------------
// Shape returned to the workspace
// ---------------------------------------------------------------------------

/** The workspace's own view of its access. Staff notes and billing columns are left out. */
export function toAppAccessView(row: AppAccessRow): AppAccessView {
  const request = row.request;
  return {
    appCode: row.appCode,
    status: row.status,
    request: request
      ? {
          companyName: request.companyName,
          website: request.website,
          contactName: request.contactName,
          contactEmail: request.contactEmail,
          useCase: request.useCase,
          expectedDailySends: request.expectedDailySends,
          targetCountries: request.targetCountries,
          listSource: request.listSource,
          ...(request.listSourceDetails ? { listSourceDetails: request.listSourceDetails } : {}),
          termsVersion: request.termsVersion,
          termsAccepted: request.termsAccepted,
          termsAcceptedAt: request.termsAcceptedAt,
          termsAcceptedBy: request.termsAcceptedBy,
        }
      : null,
    limits: row.limits,
    rejectionReason: row.rejectionReason,
    suspendedReason: row.suspendedReason,
    requestedAt: row.requestedAt ? row.requestedAt.toISOString() : null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface WorkspaceAccess {
  /** Master `workspaces.id`. */
  workspaceId: string;
  workspaceName: string;
  /** The workspace's row for the app, or null when it never asked. */
  access: AppAccessRow | null;
}

/**
 * The master workspace behind a Clerk org plus its access row for one app.
 * Null when the org has no workspace row (nothing can be requested for it).
 */
export async function getWorkspaceAccess(
  masterDb: MasterDatabase,
  clerkOrgId: string,
  appCode: string,
): Promise<WorkspaceAccess | null> {
  const [row] = await masterDb
    .select({ workspaceId: workspaces.id, workspaceName: workspaces.name, access: workspaceAppAccess })
    .from(workspaces)
    .leftJoin(
      workspaceAppAccess,
      and(eq(workspaceAppAccess.workspaceId, workspaces.id), eq(workspaceAppAccess.appCode, appCode)),
    )
    .where(matchWorkspaceRef(clerkOrgId))
    .limit(1);
  if (!row) return null;
  return { workspaceId: row.workspaceId, workspaceName: row.workspaceName, access: row.access };
}

/** `null` when the workspace never asked (or has no master row). */
export async function getAppAccessView(
  masterDb: MasterDatabase,
  clerkOrgId: string,
  appCode: string,
): Promise<AppAccessView | null> {
  const found = await getWorkspaceAccess(masterDb, clerkOrgId, appCode);
  return found?.access ? toAppAccessView(found.access) : null;
}

/** Access status per app for the catalog; apps the workspace never asked for are absent. */
export async function listAccessStatuses(
  masterDb: MasterDatabase,
  clerkOrgId: string,
): Promise<Map<string, AppAccessStatus>> {
  const rows = await masterDb
    .select({ appCode: workspaceAppAccess.appCode, status: workspaceAppAccess.status })
    .from(workspaces)
    .innerJoin(workspaceAppAccess, eq(workspaceAppAccess.workspaceId, workspaces.id))
    .where(matchWorkspaceRef(clerkOrgId));
  return new Map(rows.map((r) => [r.appCode, r.status]));
}

export type InstallAccessCheck = { ok: true } | { ok: false; status: AppAccessStatus | 'none' };

/**
 * Whether the workspace may install `appCode`. Apps that are not on request
 * (or do not exist; the install itself answers 404) always pass. A
 * `requires_approval` app passes only with an `approved` row; with no org or no
 * workspace row it fails closed.
 */
export async function checkInstallAccess(
  masterDb: MasterDatabase,
  clerkOrgId: string | null,
  appCode: string,
): Promise<InstallAccessCheck> {
  const [app] = await masterDb
    .select({ requiresApproval: appCatalog.requiresApproval })
    .from(appCatalog)
    .where(eq(appCatalog.code, appCode))
    .limit(1);
  if (!app?.requiresApproval) return { ok: true };

  if (!clerkOrgId) return { ok: false, status: 'none' };
  const found = await getWorkspaceAccess(masterDb, clerkOrgId, appCode);
  const status = found?.access?.status ?? 'none';
  return status === 'approved' ? { ok: true } : { ok: false, status };
}

/** Codes of the catalog apps that are on request only. */
export async function listRequiresApprovalCodes(masterDb: MasterDatabase): Promise<Set<string>> {
  const rows = await masterDb
    .select({ code: appCatalog.code })
    .from(appCatalog)
    .where(eq(appCatalog.requiresApproval, true));
  return new Set(rows.map((r) => r.code));
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The app exists, is active and is on request only. */
export async function isRequestableApp(masterDb: MasterDatabase, appCode: string): Promise<boolean> {
  const [app] = await masterDb
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(and(eq(appCatalog.code, appCode), eq(appCatalog.isActive, true), eq(appCatalog.requiresApproval, true)))
    .limit(1);
  return Boolean(app);
}

/**
 * Terms check for the app. WeldReach needs the current terms version and every
 * one of its terms ticked; other on-request apps have no terms of their own yet.
 * Returns the problem for a 400, or null when fine.
 */
export function validateTerms(appCode: string, input: AppAccessRequestInput): string | null {
  if (appCode !== WELDREACH_APP_CODE) return null;
  if (input.termsVersion !== WELDREACH_TERMS_VERSION) {
    return `The terms have changed. Accept version ${WELDREACH_TERMS_VERSION}.`;
  }
  const missing = WELDREACH_TERMS.filter((key) => !input.termsAccepted.includes(key));
  if (missing.length > 0) return `Every term must be accepted. Missing: ${missing.join(', ')}.`;
  return null;
}

export type RequestAppAccessResult =
  | { ok: true; access: AppAccessRow; workspaceId: string; workspaceName: string }
  | { ok: false; reason: 'workspace_not_found' }
  | { ok: false; reason: 'exists'; status: AppAccessStatus };

/**
 * File a request, or file it again after a rejection or revocation. Refused
 * while one is pending, approved or suspended. A re-request keeps the limits
 * staff set earlier; a first request starts from the app's defaults.
 *
 * The unique (workspace, app) index and the status guard on the update make
 * two concurrent requests safe: the loser sees `exists`.
 */
export async function requestAppAccess(params: {
  masterDb: MasterDatabase;
  clerkOrgId: string;
  appCode: string;
  userId: string;
  input: AppAccessRequestInput;
  now?: Date;
}): Promise<RequestAppAccessResult> {
  const { masterDb, clerkOrgId, appCode, userId, input } = params;
  const now = params.now ?? new Date();

  const found = await getWorkspaceAccess(masterDb, clerkOrgId, appCode);
  if (!found) return { ok: false, reason: 'workspace_not_found' };
  const { workspaceId, workspaceName, access: existing } = found;

  if (existing && OPEN_STATUSES.includes(existing.status)) {
    return { ok: false, reason: 'exists', status: existing.status };
  }

  const request = {
    companyName: input.companyName,
    website: input.website,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    useCase: input.useCase,
    expectedDailySends: input.expectedDailySends,
    targetCountries: input.targetCountries,
    listSource: input.listSource,
    ...(input.listSourceDetails ? { listSourceDetails: input.listSourceDetails } : {}),
    termsVersion: input.termsVersion,
    termsAccepted: input.termsAccepted,
    termsAcceptedAt: now.toISOString(),
    termsAcceptedBy: userId,
  };

  if (!existing) {
    const [inserted] = await masterDb
      .insert(workspaceAppAccess)
      .values({
        id: generateId('waa'),
        workspaceId,
        appCode,
        status: 'requested',
        request,
        limits: appCode === WELDREACH_APP_CODE ? { ...WELDREACH_DEFAULT_LIMITS } : {},
        requestedBy: userId,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return { ok: false, reason: 'exists', status: 'requested' };
    return { ok: true, access: inserted, workspaceId, workspaceName };
  }

  const [updated] = await masterDb
    .update(workspaceAppAccess)
    .set({
      status: 'requested',
      request,
      requestedBy: userId,
      requestedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      suspendedReason: null,
      updatedAt: now,
    })
    .where(and(eq(workspaceAppAccess.id, existing.id), inArray(workspaceAppAccess.status, ['rejected', 'revoked'])))
    .returning();
  if (!updated) return { ok: false, reason: 'exists', status: 'requested' };
  return { ok: true, access: updated, workspaceId, workspaceName };
}
