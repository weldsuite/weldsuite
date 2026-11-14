/**
 * What the PyIceberg job is told to do in one run (container/maintenance.py
 * reads exactly this): the erasures to rewrite out of the four tables and how
 * long each project's events are kept.
 *
 * Retention comes from the plan (`@weldsuite/panel-domain/plans`: 12 months on
 * Free, 25 above), and is sent grouped by months, so the spec stays small
 * however many projects there are. Rows of projects the registry does not know
 * (deleted ones) go with the longest retention.
 */

import { isNull, eq } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import { panelPlanLimits } from '@weldsuite/panel-domain/plans';
import type { PendingErasure } from './ledger';

const { panelProjectRegistry, plans, workspaces } = masterSchema;

export interface RetentionGroup {
  /** Events (and recording chunk rows) older than this many months are dropped. */
  months: number;
  projectIds: string[];
}

export interface MaintenanceJobSpec {
  /** The workflow instance id: a repeated start with it answers with the job that exists. */
  runId: string;
  /** The run's clock, ISO 8601: cutoffs and the erasure snapshot are relative to it. */
  now: string;
  erasures: Array<{ workspaceId: string; projectId: string; ids: string[] }>;
  retention: RetentionGroup[];
  /** Rows older than this in any project, registered or not. */
  maxRetentionMonths: number;
}

export interface MaintenanceJobResult {
  erased: { events: number; identities: number; people: number; replayChunks: number };
  expired: { events: number; replayChunks: number };
}

/** Project ids by how many months their plan keeps events, live projects only. */
export async function loadRetention(masterDb: AnyMasterDatabase): Promise<RetentionGroup[]> {
  const rows = await masterDb
    .select({ projectId: panelProjectRegistry.projectId, slug: plans.slug, features: plans.features })
    .from(panelProjectRegistry)
    .leftJoin(workspaces, eq(workspaces.id, panelProjectRegistry.workspaceId))
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(isNull(panelProjectRegistry.deletedAt));

  const groups = new Map<number, string[]>();
  for (const row of rows) {
    const months = panelPlanLimits(row.slug, row.features).eventRetentionMonths;
    groups.set(months, [...(groups.get(months) ?? []), row.projectId]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([months, projectIds]) => ({ months, projectIds: projectIds.sort() }));
}

export function buildSpec(input: {
  runId: string;
  now: Date;
  erasures: PendingErasure[];
  retention: RetentionGroup[];
}): MaintenanceJobSpec {
  const maxRetentionMonths = Math.max(panelPlanLimits('enterprise').eventRetentionMonths, ...input.retention.map((g) => g.months));
  return {
    runId: input.runId,
    now: input.now.toISOString(),
    erasures: input.erasures.map(({ workspaceId, projectId, ids }) => ({ workspaceId, projectId, ids })),
    retention: input.retention,
    maxRetentionMonths,
  };
}

/** The Data Catalog the job opens: the R2 bucket's REST catalog. */
export function catalogFor(env: { CF_ACCOUNT_ID: string; PANEL_BASIN_BUCKET: string; PANEL_CATALOG_URI?: string; PANEL_CATALOG_WAREHOUSE?: string }) {
  return {
    uri: env.PANEL_CATALOG_URI || `https://catalog.cloudflarestorage.com/${env.CF_ACCOUNT_ID}/${env.PANEL_BASIN_BUCKET}`,
    warehouse: env.PANEL_CATALOG_WAREHOUSE || `${env.CF_ACCOUNT_ID}_${env.PANEL_BASIN_BUCKET}`,
  };
}
