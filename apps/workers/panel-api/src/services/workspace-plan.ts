/**
 * The workspace and what its plan includes of WeldPanel (`@weldsuite/panel-domain/plans`);
 * a workspace without a plan gets the Free numbers.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { panelPlanLimits, type PanelPlanLimits } from '@weldsuite/panel-domain/plans';

const { plans, workspaces } = masterSchema;

export interface WorkspacePlan {
  id: string;
  name: string;
  clerkOrgId: string | null;
  planSlug: string | null;
  limits: PanelPlanLimits;
}

/** The workspace and what its plan includes of WeldPanel; null when there is no such workspace. */
export async function loadWorkspacePlan(masterDb: AnyMasterDatabase, workspaceId: string): Promise<WorkspacePlan | null> {
  const [row] = await masterDb
    .select({
      id: workspaces.id,
      name: workspaces.name,
      clerkOrgId: workspaces.clerkOrgId,
      slug: plans.slug,
      features: plans.features,
    })
    .from(workspaces)
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    clerkOrgId: row.clerkOrgId ?? null,
    planSlug: row.slug ?? null,
    limits: panelPlanLimits(row.slug, row.features),
  };
}
