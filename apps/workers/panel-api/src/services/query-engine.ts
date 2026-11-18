/**
 * What running a spec needs besides the compiler: the Basin executor, and the
 * context (scope, retention, erased ids, saved cohorts and page groups, the
 * custom events, computed properties, path rules and group types the spec
 * uses) built from the tenant DB, the master DB and the project's Durable Object.
 *
 * Only the definitions a spec refers to are loaded (`specReferences`), each
 * scoped to the project, and a definition that no longer parses is left out
 * (the compiler then refuses the spec with a 400 naming what is missing).
 *
 * Fails closed: without the Durable Object the erased ids are unknown, and a
 * query that ignored them would show people who asked to be forgotten.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { basinSql } from '@weldsuite/worker-kit/basin';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import {
  panelCohortFilterSchema,
  type PanelPathRule,
  type ParsedPanelCohortFilter,
  type ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  panelComputedPropertyDefinitionSchema,
  panelCustomEventDefinitionSchema,
  type ParsedPanelComputedPropertyDefinition,
  type ParsedPanelCustomEventDefinition,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import {
  customEventReferences,
  eventRetentionDays,
  specReferences,
  type PanelQueryContext,
  type PanelSqlExecutor,
} from '@weldsuite/panel-domain/query';
import type { Env } from '../types';

const { panelCohorts, panelComputedProperties, panelCustomEvents, panelGroupTypes, panelHeatmapPages, panelPathRules, panelSessionFavorites } = schema;
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
  return specReferences(spec).cohortIds;
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

/** Custom events of the project by id, parsed; deleted or unparseable ones are left out. */
export async function loadCustomEvents(db: Database, projectId: string, ids: readonly string[]): Promise<Record<string, ParsedPanelCustomEventDefinition>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: panelCustomEvents.id, definition: panelCustomEvents.definition })
    .from(panelCustomEvents)
    .where(and(eq(panelCustomEvents.projectId, projectId), inArray(panelCustomEvents.id, [...ids]), isNull(panelCustomEvents.deletedAt)));
  const out: Record<string, ParsedPanelCustomEventDefinition> = {};
  for (const row of rows) {
    const parsed = panelCustomEventDefinitionSchema.safeParse(row.definition);
    if (parsed.success) out[row.id] = parsed.data;
  }
  return out;
}

/** Computed properties of the project by id, parsed; deleted or unparseable ones are left out. */
export async function loadComputedProperties(
  db: Database,
  projectId: string,
  ids: readonly string[],
): Promise<Record<string, ParsedPanelComputedPropertyDefinition>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: panelComputedProperties.id, definition: panelComputedProperties.definition })
    .from(panelComputedProperties)
    .where(and(eq(panelComputedProperties.projectId, projectId), inArray(panelComputedProperties.id, [...ids]), isNull(panelComputedProperties.deletedAt)));
  const out: Record<string, ParsedPanelComputedPropertyDefinition> = {};
  for (const row of rows) {
    const parsed = panelComputedPropertyDefinitionSchema.safeParse(row.definition);
    if (parsed.success) out[row.id] = parsed.data;
  }
  return out;
}

/** The project's path rules in order. */
export async function loadPathRules(db: Database, projectId: string): Promise<PanelPathRule[]> {
  return db
    .select({ pattern: panelPathRules.pattern, replacement: panelPathRules.replacement })
    .from(panelPathRules)
    .where(eq(panelPathRules.projectId, projectId))
    .orderBy(asc(panelPathRules.position));
}

/** The project's group types (`company`, ...). */
export async function loadGroupTypes(db: Database, projectId: string): Promise<string[]> {
  const rows = await db.select({ groupType: panelGroupTypes.groupType }).from(panelGroupTypes).where(eq(panelGroupTypes.projectId, projectId));
  return rows.map((r) => r.groupType);
}

export interface Definitions {
  customEvents: Record<string, ParsedPanelCustomEventDefinition>;
  computedProperties: Record<string, ParsedPanelComputedPropertyDefinition>;
  pathRules: PanelPathRule[];
  groupTypes: string[] | undefined;
}

/** The custom events, computed properties, path rules and group types a spec uses (and only those). */
export async function loadDefinitions(db: Database, projectId: string, spec: ParsedPanelQuerySpec): Promise<Definitions> {
  const refs = specReferences(spec);
  const customEvents = await loadCustomEvents(db, projectId, refs.customEventIds);
  const inner = customEventReferences(Object.values(customEvents));
  const computedIds = [...new Set([...refs.computedPropertyIds, ...inner.computedPropertyIds])];
  const usesGroups = refs.groupTypes.length > 0 || inner.groupTypes.length > 0;
  const [computedProperties, pathRules, groupTypes] = await Promise.all([
    loadComputedProperties(db, projectId, computedIds),
    refs.usesPathRules ? loadPathRules(db, projectId) : Promise.resolve([]),
    usesGroups ? loadGroupTypes(db, projectId) : Promise.resolve(undefined),
  ]);
  return { customEvents, computedProperties, pathRules, groupTypes };
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
  const [erasedIds, hasIdentifiedUsers, planSlug, cohorts, pageGroups, favourites, definitions] = await Promise.all([
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
    loadDefinitions(tenantDb, projectId, spec),
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
    customEvents: definitions.customEvents,
    computedProperties: definitions.computedProperties,
    pathRules: definitions.pathRules,
    ...(definitions.groupTypes ? { groupTypes: definitions.groupTypes } : {}),
  };
}
