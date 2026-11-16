/**
 * What running a spec needs besides the compiler: the Basin executor, and the
 * context (scope, retention, erased ids, saved cohorts and page groups) built
 * from the tenant DB, the master DB and the project's Durable Object.
 *
 * Fails closed: without the Durable Object the erased ids are unknown, and a
 * query that ignored them would show people who asked to be forgotten.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { basinSql } from '@weldsuite/worker-kit/basin';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { panelCohortFilterSchema, type ParsedPanelCohortFilter, type ParsedPanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import { eventRetentionDays, type PanelQueryContext, type PanelSqlExecutor } from '@weldsuite/panel-domain/query';
import type { Env } from '../types';

const { panelCohorts, panelHeatmapPages, panelSessionFavorites } = schema;
const { plans, workspaces } = masterSchema;

/** The query layer is not configured in this environment (a binding or secret is missing). */
export class QueryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryUnavailableError';
  }
}

export function basinExecutor(env: Env): PanelSqlExecutor {
  const { R2_SQL_API_TOKEN: token, CF_ACCOUNT_ID: accountId, PANEL_BASIN_BUCKET: bucket } = env;
  if (!token || !accountId || !bucket) throw new QueryUnavailableError('Analytics queries are not configured here');
  return (query) => basinSql({ token, accountId, bucket }, query.sql);
}

/** Every cohort id a spec refers to (filters, step and series filters, the recordings cohort). */
export function collectCohortIds(spec: ParsedPanelQuerySpec): string[] {
  const ids = new Set<string>();
  const fromFilters = (filters: readonly { source: string; cohortId?: string }[] | undefined) => {
    for (const f of filters ?? []) if (f.source === 'cohort' && f.cohortId) ids.add(f.cohortId);
  };
  if ('filters' in spec) fromFilters(spec.filters);
  if (spec.kind === 'trends') for (const s of spec.series) fromFilters(s.filters);
  if (spec.kind === 'funnel') for (const s of spec.steps) fromFilters(s.filters);
  if (spec.kind === 'flows') fromFilters(spec.anchor.filters);
  if (spec.kind === 'sessions' && spec.cohortId) ids.add(spec.cohortId);
  return [...ids];
}

async function loadPlanSlug(master: AnyMasterDatabase, workspaceId: string): Promise<string | null> {
  const [row] = await master
    .select({ slug: plans.slug })
    .from(workspaces)
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.slug ?? null;
}

export async function loadCohortFilters(db: Database, projectId: string, ids: readonly string[]): Promise<Record<string, ParsedPanelCohortFilter>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select()
    .from(panelCohorts)
    .where(and(eq(panelCohorts.projectId, projectId), inArray(panelCohorts.id, [...ids]), isNull(panelCohorts.deletedAt)));
  const out: Record<string, ParsedPanelCohortFilter> = {};
  for (const row of rows) {
    const parsed = panelCohortFilterSchema.safeParse(row.filter);
    if (parsed.success) out[row.id] = parsed.data;
  }
  return out;
}

export interface ContextInput {
  env: Env;
  tenantDb: Database;
  masterDb: AnyMasterDatabase;
  workspaceId: string;
  projectId: string;
  spec: ParsedPanelQuerySpec;
}

/** The compiler's scope for one request. Throws {@link QueryUnavailableError} when the project's object is unreachable. */
export async function buildQueryContext(input: ContextInput): Promise<PanelQueryContext> {
  const { env, tenantDb, masterDb, workspaceId, projectId, spec } = input;
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('Analytics queries are not configured here');
  const stub = projectObjectStub(env.PANEL_PROJECT, projectId);

  const pageGroupId = spec.kind === 'heatmap' ? spec.pageGroupId : undefined;
  const [erasedIds, hasIdentifiedUsers, planSlug, cohorts, pageGroups, favourites] = await Promise.all([
    stub.erasedIds(),
    stub.hasIdentifiedUsers(),
    loadPlanSlug(masterDb, workspaceId),
    loadCohortFilters(tenantDb, projectId, collectCohortIds(spec)),
    pageGroupId
      ? tenantDb
          .select({ id: panelHeatmapPages.id, urlPattern: panelHeatmapPages.urlPattern })
          .from(panelHeatmapPages)
          .where(and(eq(panelHeatmapPages.projectId, projectId), eq(panelHeatmapPages.id, pageGroupId)))
      : Promise.resolve([]),
    spec.kind === 'sessions' && spec.favoritesOnly
      ? tenantDb.select({ sessionId: panelSessionFavorites.sessionId }).from(panelSessionFavorites).where(eq(panelSessionFavorites.projectId, projectId))
      : Promise.resolve([]),
  ]);

  return {
    workspaceId,
    projectId,
    retentionDays: eventRetentionDays(planSlug),
    hasIdentifiedUsers,
    erasedIds,
    cohorts,
    pageGroups: Object.fromEntries(pageGroups.map((g) => [g.id, g.urlPattern])),
    favoriteSessionIds: favourites.map((f) => f.sessionId),
  };
}
