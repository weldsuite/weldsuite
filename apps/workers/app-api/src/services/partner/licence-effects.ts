/**
 * What follows a licence write on a managed workspace, in one place so the
 * licence PUT and the status change cannot drift apart:
 *
 *   installed apps → credit allowance → Clerk seat cap → cache invalidation
 *
 * Master-DB bookkeeping (the licence row, its history, `workspaces.plan_id`)
 * is already done by `upsertWorkspaceLicence` / `setLicenceStatus`. No entity
 * event: this is master data, like credits (see routes/partner/index.ts).
 *
 * Every step is best effort after the licence is saved: the licence row is the
 * source of truth, and the cache TTL, the daily credit reset and the next
 * licence write all converge on it. A failed step is reported in `warnings`
 * instead of failing a write that already happened.
 */

import {
  applyLicenceCredits,
  countActiveMembers,
  invalidateWorkspaceContexts,
  syncInstalledAppsToLicence,
  type LicenceActor,
} from '@weldsuite/core-domain/partners';
import type { LicenceSnapshot } from '@weldsuite/app-api-client/schemas/partners';
import { getTenantDbForWorkspace, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { syncClerkSeatLimit } from '../billing';

export interface LicenceEffectsInput {
  env: Env;
  masterDb: MasterDatabase;
  workspace: { id: string; clerkOrgId: string | null };
  /** The licence as saved. */
  licence: LicenceSnapshot;
  /** The licence before this write; null for a first licence. */
  previous: LicenceSnapshot | null;
  /** `workspace_licence_changes.id`, the idempotency key of the credit grant. */
  changeId: string;
  actor: LicenceActor;
}

/** Clerk's cap for a licence: the seat cap, never below who is already in; 0 clears it. */
export function clerkSeatCap(maxSeats: number | null, activeMembers: number): number {
  if (maxSeats === null) return 0;
  return Math.max(maxSeats, activeMembers);
}

export async function applyLicenceEffects(input: LicenceEffectsInput): Promise<{ warnings: string[] }> {
  const { env, masterDb, workspace, licence, previous } = input;
  const warnings: string[] = [];

  // Installed apps follow the licence while it is active. A suspended or ended
  // licence leaves them as they are (the API gate and read-only mode govern use),
  // so resuming does not reshuffle the sidebar.
  if (licence.status === 'active' && workspace.clerkOrgId) {
    try {
      const tenantDb = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
      await syncInstalledAppsToLicence({
        tenantDb,
        allowedApps: licence.allowedApps,
        actorUserId: input.actor.id,
      });
    } catch (err) {
      console.error('[partner] Installed-app sync failed:', err);
      warnings.push('installed_apps');
    }
  }

  try {
    await applyLicenceCredits({
      db: masterDb,
      workspaceId: workspace.id,
      previousMonthlyCredits: previous ? previous.monthlyCredits : null,
      monthlyCredits: licence.monthlyCredits,
      creditRolloverCap: licence.creditRolloverCap,
      changeId: input.changeId,
    });
  } catch (err) {
    console.error('[partner] Credit allowance update failed:', err);
    warnings.push('credits');
  }

  if (workspace.clerkOrgId) {
    try {
      const members = await countActiveMembers(masterDb, [workspace.id]);
      await syncClerkSeatLimit(
        env.CLERK_SECRET_KEY,
        workspace.clerkOrgId,
        clerkSeatCap(licence.maxSeats, members.get(workspace.id) ?? 0),
      );
    } catch (err) {
      console.error('[partner] Clerk seat cap sync failed:', err);
      warnings.push('seat_cap');
    }
  }

  try {
    await invalidateWorkspaceContexts(env.WORKSPACE_CACHE, [workspace.clerkOrgId]);
  } catch (err) {
    console.error('[partner] Workspace cache invalidation failed:', err);
    warnings.push('cache');
  }

  return { warnings };
}
