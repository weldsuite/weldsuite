'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, max } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { recordConsoleAudit } from '@/lib/audit';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from '@/lib/db';
import { generateId } from '@/lib/id';
import {
  WELDREACH_APP_CODE,
  parseLimitsForm,
  planAccessUpdate,
  type AccessAction,
  type LimitsFormValues,
} from '@/lib/app-access';
import { getAppAccess, requesterContact, type AppAccessDetail } from '@/lib/app-access-data';
import { sendAccessApprovedEmail, sendAccessRejectedEmail } from '@/lib/app-access-email';
import type { ActionResult } from './workspaces';

const { workspaceAppAccess, workspaces, appCatalog } = masterSchema;

/**
 * Staff decisions on access to apps that are on request only (WeldReach first).
 * Every action: `guardWrite()` (no read-only viewers), a master-DB update of
 * `workspace_app_access`, an audit row, and a revalidate of the screens.
 *
 * The module worker (`appAccessGate`) caches a workspace's status in KV for 60 s
 * (`appaccess:<clerkOrgId>:<appCode>`). This console has no Cloudflare KV
 * client, so a change reaches the request path within that minute rather than
 * at once. WeldReach's send consumer reads the master DB on every batch, so
 * suspending or revoking stops sending immediately regardless.
 */

/** What every action hands back; `warnings` become warning toasts (see ActionDialog). */
export interface AppAccessActionData {
  access: AppAccessDetail;
  warnings: string[];
}

const NOT_FOUND = 'This workspace has not asked for access to that app.';

function refresh(workspaceId: string, accessId?: string): void {
  revalidatePath('/access-requests');
  if (accessId) revalidatePath(`/access-requests/${accessId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

/** Puts the app in the workspace's own database, as the app-api install endpoint does. */
async function installInTenant(clerkOrgId: string | null, appCode: string, installedBy: string): Promise<string | null> {
  if (!clerkOrgId) {
    return `Approved, but the workspace has no organization, so ${appCode} was not installed in it.`;
  }
  try {
    const tenantDb = await getTenantDbForWorkspace(clerkOrgId);
    const { workspaceInstalledApps } = schema;
    const now = new Date();

    const [existing] = await tenantDb
      .select({
        id: workspaceInstalledApps.id,
        isActive: workspaceInstalledApps.isActive,
        deletedAt: workspaceInstalledApps.deletedAt,
      })
      .from(workspaceInstalledApps)
      .where(eq(workspaceInstalledApps.appCode, appCode))
      .limit(1);

    if (existing) {
      if (existing.isActive && !existing.deletedAt) return null;
      await tenantDb
        .update(workspaceInstalledApps)
        .set({ isActive: true, deletedAt: null, installedAt: now, installedBy, updatedAt: now })
        .where(eq(workspaceInstalledApps.id, existing.id));
      return null;
    }

    const [order] = await tenantDb.select({ top: max(workspaceInstalledApps.displayOrder) }).from(workspaceInstalledApps);
    await tenantDb
      .insert(workspaceInstalledApps)
      .values({
        id: generateId('wia'),
        appCode,
        isActive: true,
        displayOrder: (order?.top ?? -1) + 1,
        settings: {},
        installedAt: now,
        installedBy,
      })
      .onConflictDoNothing();
    return null;
  } catch (err) {
    console.error(`[admin/app-access] installing ${appCode} in the workspace failed:`, err);
    const detail = err instanceof Error ? err.message : 'unknown error';
    return `Approved, but installing ${appCode} in the workspace failed (${detail}). Its admins can install it from the App Store.`;
  }
}

async function changeStatus(
  action: AccessAction,
  workspaceId: string,
  appCode: string,
  reason: string,
): Promise<ActionResult<AppAccessActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isText(workspaceId) || !isText(appCode) || !isText(reason)) return { ok: false, error: 'Invalid request.' };

  const db = getMasterDb();
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, clerkOrgId: workspaces.clerkOrgId, deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) return { ok: false, error: 'Workspace not found.' };
  if (workspace.deletedAt) return { ok: false, error: 'This workspace has been deleted.' };

  const current = await getAppAccess(workspaceId, appCode);
  if (!current) {
    if (action !== 'approve') return { ok: false, error: NOT_FOUND };
    const [app] = await db.select({ code: appCatalog.code }).from(appCatalog).where(eq(appCatalog.code, appCode)).limit(1);
    if (!app) return { ok: false, error: `Unknown app "${appCode}".` };
  }

  const planned = planAccessUpdate({
    action,
    from: current?.status ?? 'none',
    appCode,
    reason,
    reviewer: guard.identity.email,
    currentLimits: current && !current.limitsUnset ? current.limits : {},
  });
  if (!planned.ok) return { ok: false, error: planned.error };
  const set = planned.set;
  const now = new Date();

  if (current) {
    // Guarded on the status we planned from, so two staff acting at once cannot both win.
    const updated = await db
      .update(workspaceAppAccess)
      .set({ ...set, updatedAt: now })
      .where(and(eq(workspaceAppAccess.id, current.id), eq(workspaceAppAccess.status, current.status)))
      .returning({ id: workspaceAppAccess.id });
    if (updated.length === 0) {
      return { ok: false, error: 'Someone else just changed this request. Reload the page and try again.' };
    }
  } else {
    await db
      .insert(workspaceAppAccess)
      .values({
        id: generateId('waa'),
        workspaceId,
        appCode,
        status: set.status,
        limits: set.limits ?? {},
        reviewedBy: set.reviewedBy,
        reviewedAt: set.reviewedAt,
        rejectionReason: set.rejectionReason,
        suspendedReason: set.suspendedReason,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId,
    action: `app_access.${action}`,
    outcome: 'success',
    reason: reason.trim(),
    details: { appCode, from: current?.status ?? 'none', to: set.status },
  });

  const refreshed = await getAppAccess(workspaceId, appCode);
  if (!refreshed) return { ok: false, error: NOT_FOUND };

  const warnings: string[] = [];
  const contact = requesterContact(refreshed);

  if (action === 'approve') {
    const installWarning = await installInTenant(workspace.clerkOrgId, appCode, refreshed.requestedBy ?? 'admin-console');
    if (installWarning) warnings.push(installWarning);
    // Only a workspace that asked is emailed; a grant staff made on their own has nobody to tell.
    if (refreshed.request) {
      const outcome = await sendAccessApprovedEmail({
        to: contact.email,
        recipientName: contact.name,
        workspaceName: workspace.name,
        limits: refreshed.limits,
      });
      if (outcome !== 'sent') warnings.push('The requester was not emailed about the approval. Tell them yourself.');
    }
  } else if (action === 'reject') {
    const outcome = await sendAccessRejectedEmail({
      to: contact.email,
      recipientName: contact.name,
      workspaceName: workspace.name,
      reason: reason.trim(),
    });
    if (outcome !== 'sent') warnings.push('The requester was not emailed about the rejection. Tell them yourself.');
  }

  refresh(workspaceId, refreshed.id);
  return { ok: true, data: { access: refreshed, warnings } };
}

/** Approve (also installs the app in the workspace and emails the requester). */
export async function approveAppAccess(workspaceId: string, appCode: string, reason: string) {
  return changeStatus('approve', workspaceId, appCode, reason);
}

/** Reject. The reason is shown to the workspace and emailed to the requester. */
export async function rejectAppAccess(workspaceId: string, appCode: string, reason: string) {
  return changeStatus('reject', workspaceId, appCode, reason);
}

/** Suspend. The reason is shown to the workspace. */
export async function suspendAppAccess(workspaceId: string, appCode: string, reason: string) {
  return changeStatus('suspend', workspaceId, appCode, reason);
}

export async function unsuspendAppAccess(workspaceId: string, appCode: string, reason: string) {
  return changeStatus('unsuspend', workspaceId, appCode, reason);
}

export async function revokeAppAccess(workspaceId: string, appCode: string, reason: string) {
  return changeStatus('revoke', workspaceId, appCode, reason);
}

/** Saves the limits of a WeldReach workspace; they apply on the next request the module handles. */
export async function updateAppAccessLimits(
  workspaceId: string,
  appCode: string,
  values: LimitsFormValues,
): Promise<ActionResult<AppAccessActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isText(workspaceId) || !isText(appCode) || typeof values !== 'object' || values === null) {
    return { ok: false, error: 'Invalid request.' };
  }
  if (appCode !== WELDREACH_APP_CODE) return { ok: false, error: 'This app has no limits to edit.' };

  const parsed = parseLimitsForm(values);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const current = await getAppAccess(workspaceId, appCode);
  if (!current) return { ok: false, error: NOT_FOUND };

  const db = getMasterDb();
  await db
    .update(workspaceAppAccess)
    .set({ limits: { ...parsed.limits }, updatedAt: new Date() })
    .where(eq(workspaceAppAccess.id, current.id));

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId,
    action: 'app_access.limits_update',
    outcome: 'success',
    details: { appCode, before: current.limits, after: parsed.limits },
  });

  const refreshed = await getAppAccess(workspaceId, appCode);
  if (!refreshed) return { ok: false, error: NOT_FOUND };
  refresh(workspaceId, refreshed.id);
  return { ok: true, data: { access: refreshed, warnings: [] } };
}

const MAX_NOTES_LENGTH = 4000;

/** Internal notes; never shown to the workspace. */
export async function updateAppAccessNotes(
  workspaceId: string,
  appCode: string,
  notes: string,
): Promise<ActionResult<AppAccessActionData>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!isText(workspaceId) || !isText(appCode) || !isText(notes)) return { ok: false, error: 'Invalid request.' };
  if (notes.length > MAX_NOTES_LENGTH) return { ok: false, error: `Notes can be at most ${MAX_NOTES_LENGTH} characters.` };

  const current = await getAppAccess(workspaceId, appCode);
  if (!current) return { ok: false, error: NOT_FOUND };

  const trimmed = notes.trim();
  const db = getMasterDb();
  await db
    .update(workspaceAppAccess)
    .set({ reviewNotes: trimmed || null, updatedAt: new Date() })
    .where(eq(workspaceAppAccess.id, current.id));

  await recordConsoleAudit({
    identity: guard.identity,
    workspaceId,
    action: 'app_access.notes_update',
    outcome: 'success',
    details: { appCode, length: trimmed.length },
  });

  const refreshed = await getAppAccess(workspaceId, appCode);
  if (!refreshed) return { ok: false, error: NOT_FOUND };
  refresh(workspaceId, refreshed.id);
  return { ok: true, data: { access: refreshed, warnings: [] } };
}
