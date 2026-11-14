/**
 * Reports, dashboards (with tiles) and cohorts: the tenant rows, their DTOs
 * and the visibility rule.
 *
 * Visibility: a `private` report or dashboard is its owner's alone (anyone
 * else gets a 404, admins included); `workspace` ones are everybody's with
 * `panel_reports:read`. Changing or deleting is for the owner, or for someone
 * with `panel_projects:manage` (workspace admins) on a shared object.
 */

import { and, asc, desc, eq, inArray, isNull, or, type AnyColumn, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelCohort, PanelDashboard, PanelDashboardTile, PanelReport, PanelTileLayout } from '@weldsuite/db/schema';
import type {
  CreatePanelCohortInput,
  CreatePanelDashboardInput,
  CreatePanelReportInput,
  PanelCohortDto,
  PanelDashboardDetailDto,
  PanelDashboardDto,
  PanelDashboardTileDto,
  PanelReportDto,
  UpdatePanelCohortInput,
  UpdatePanelDashboardInput,
  UpdatePanelReportInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';

const { panelCohorts, panelDashboardTiles, panelDashboards, panelProjects, panelReports } = schema;

export type Scope = 'all' | 'mine' | 'shared';

export interface Actor {
  userId: string;
  /** Holds `panel_projects:manage`: may change shared objects of others. */
  canManage: boolean;
}

/** A project id that exists (not deleted) in this workspace's tenant DB. */
export async function projectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: panelProjects.id })
    .from(panelProjects)
    .where(and(eq(panelProjects.id, projectId), isNull(panelProjects.deletedAt)))
    .limit(1);
  return !!row;
}

type Owned = { ownerUserId: string; visibility: 'private' | 'workspace' };

export function canSee(object: Owned, actor: Actor): boolean {
  return object.ownerUserId === actor.userId || object.visibility === 'workspace';
}

export function canChange(object: Owned, actor: Actor): boolean {
  if (object.ownerUserId === actor.userId) return true;
  return object.visibility === 'workspace' && actor.canManage;
}

function scopeCondition(
  columns: { ownerUserId: AnyColumn; visibility: AnyColumn },
  scope: Scope,
  userId: string,
): SQL {
  if (scope === 'mine') return eq(columns.ownerUserId, userId);
  if (scope === 'shared') return eq(columns.visibility, 'workspace');
  return or(eq(columns.ownerUserId, userId), eq(columns.visibility, 'workspace')) as SQL;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function toReportDto(r: PanelReport): PanelReportDto {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind as PanelReportDto['kind'],
    name: r.name,
    description: r.description,
    spec: r.spec,
    ownerUserId: r.ownerUserId,
    visibility: r.visibility,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function reportEventData(r: PanelReport) {
  return { id: r.id, projectId: r.projectId, name: r.name, kind: r.kind, visibility: r.visibility };
}

export async function listReports(
  db: Database,
  actor: Actor,
  params: { projectId?: string; kind?: string; scope?: Scope },
): Promise<PanelReport[]> {
  const conds: SQL[] = [isNull(panelReports.deletedAt), scopeCondition(panelReports, params.scope ?? 'all', actor.userId)];
  if (params.projectId) conds.push(eq(panelReports.projectId, params.projectId));
  if (params.kind) conds.push(eq(panelReports.kind, params.kind as PanelReport['kind']));
  return db.select().from(panelReports).where(and(...conds)).orderBy(desc(panelReports.updatedAt)).limit(500);
}

export async function getReport(db: Database, id: string): Promise<PanelReport | null> {
  const [row] = await db.select().from(panelReports).where(and(eq(panelReports.id, id), isNull(panelReports.deletedAt))).limit(1);
  return row ?? null;
}

export async function createReport(db: Database, input: CreatePanelReportInput, userId: string): Promise<PanelReport> {
  const [row] = await db
    .insert(panelReports)
    .values({
      id: generateId('pnr'),
      projectId: input.projectId,
      kind: input.spec.kind as PanelReport['kind'],
      name: input.name,
      description: input.description ?? null,
      spec: input.spec as unknown as Record<string, unknown>,
      ownerUserId: userId,
      visibility: input.visibility ?? 'private',
    })
    .returning();
  return row as PanelReport;
}

export async function updateReport(db: Database, id: string, input: UpdatePanelReportInput): Promise<PanelReport | null> {
  const [row] = await db
    .update(panelReports)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      ...(input.spec !== undefined && { spec: input.spec as unknown as Record<string, unknown>, kind: input.spec.kind as PanelReport['kind'] }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelReports.id, id), isNull(panelReports.deletedAt)))
    .returning();
  return row ?? null;
}

/** Soft-deletes the report and removes it from every dashboard. */
export async function deleteReport(db: Database, id: string): Promise<PanelReport | null> {
  const [row] = await db
    .update(panelReports)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelReports.id, id), isNull(panelReports.deletedAt)))
    .returning();
  if (row) await db.delete(panelDashboardTiles).where(eq(panelDashboardTiles.reportId, id));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export function toDashboardDto(d: PanelDashboard): PanelDashboardDto {
  return {
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    description: d.description,
    ownerUserId: d.ownerUserId,
    visibility: d.visibility,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function toTileDto(t: PanelDashboardTile): PanelDashboardTileDto {
  return { id: t.id, dashboardId: t.dashboardId, reportId: t.reportId, layout: t.layout, createdAt: t.createdAt.toISOString() };
}

export function dashboardEventData(d: PanelDashboard) {
  return { id: d.id, projectId: d.projectId, name: d.name, visibility: d.visibility };
}

export async function listDashboards(db: Database, actor: Actor, params: { projectId?: string; scope?: Scope }): Promise<PanelDashboard[]> {
  const conds: SQL[] = [isNull(panelDashboards.deletedAt), scopeCondition(panelDashboards, params.scope ?? 'all', actor.userId)];
  if (params.projectId) conds.push(eq(panelDashboards.projectId, params.projectId));
  return db.select().from(panelDashboards).where(and(...conds)).orderBy(desc(panelDashboards.updatedAt)).limit(500);
}

export async function getDashboard(db: Database, id: string): Promise<PanelDashboard | null> {
  const [row] = await db.select().from(panelDashboards).where(and(eq(panelDashboards.id, id), isNull(panelDashboards.deletedAt))).limit(1);
  return row ?? null;
}

export async function createDashboard(db: Database, input: CreatePanelDashboardInput, userId: string): Promise<PanelDashboard> {
  const [row] = await db
    .insert(panelDashboards)
    .values({
      id: generateId('pnd'),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      ownerUserId: userId,
      visibility: input.visibility ?? 'private',
    })
    .returning();
  return row as PanelDashboard;
}

export async function updateDashboard(db: Database, id: string, input: UpdatePanelDashboardInput): Promise<PanelDashboard | null> {
  const [row] = await db
    .update(panelDashboards)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelDashboards.id, id), isNull(panelDashboards.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteDashboard(db: Database, id: string): Promise<PanelDashboard | null> {
  const [row] = await db
    .update(panelDashboards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelDashboards.id, id), isNull(panelDashboards.deletedAt)))
    .returning();
  if (row) await db.delete(panelDashboardTiles).where(eq(panelDashboardTiles.dashboardId, id));
  return row ?? null;
}

export async function listTiles(db: Database, dashboardId: string): Promise<PanelDashboardTile[]> {
  return db.select().from(panelDashboardTiles).where(eq(panelDashboardTiles.dashboardId, dashboardId)).orderBy(asc(panelDashboardTiles.createdAt));
}

/** The dashboard with its tiles and the reports on them that `actor` may see. */
export async function dashboardDetail(db: Database, dashboard: PanelDashboard, actor: Actor): Promise<PanelDashboardDetailDto> {
  const tiles = await listTiles(db, dashboard.id);
  const reportIds = [...new Set(tiles.map((t) => t.reportId))];
  const reports = reportIds.length
    ? await db.select().from(panelReports).where(and(inArray(panelReports.id, reportIds), isNull(panelReports.deletedAt)))
    : [];
  const visible = reports.filter((r) => canSee(r, actor));
  const visibleIds = new Set(visible.map((r) => r.id));
  return {
    ...toDashboardDto(dashboard),
    tiles: tiles.filter((t) => visibleIds.has(t.reportId)).map(toTileDto),
    reports: visible.map(toReportDto),
  };
}

export async function addTile(db: Database, dashboardId: string, reportId: string, layout: PanelTileLayout): Promise<PanelDashboardTile> {
  const [row] = await db.insert(panelDashboardTiles).values({ id: generateId('pnt'), dashboardId, reportId, layout }).returning();
  return row as PanelDashboardTile;
}

export async function updateTile(db: Database, dashboardId: string, tileId: string, layout: PanelTileLayout): Promise<PanelDashboardTile | null> {
  const [row] = await db
    .update(panelDashboardTiles)
    .set({ layout })
    .where(and(eq(panelDashboardTiles.id, tileId), eq(panelDashboardTiles.dashboardId, dashboardId)))
    .returning();
  return row ?? null;
}

export async function removeTile(db: Database, dashboardId: string, tileId: string): Promise<boolean> {
  const rows = await db
    .delete(panelDashboardTiles)
    .where(and(eq(panelDashboardTiles.id, tileId), eq(panelDashboardTiles.dashboardId, dashboardId)))
    .returning({ id: panelDashboardTiles.id });
  return rows.length > 0;
}

/** Sets every listed tile's layout; false when a tile is not on the dashboard (nothing changes then). */
export async function setLayout(db: Database, dashboardId: string, tiles: { id: string; layout: PanelTileLayout }[]): Promise<boolean> {
  const existing = new Set((await listTiles(db, dashboardId)).map((t) => t.id));
  if (!tiles.every((t) => existing.has(t.id))) return false;
  for (const tile of tiles) await updateTile(db, dashboardId, tile.id, tile.layout);
  return true;
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export function toCohortDto(c: PanelCohort): PanelCohortDto {
  return {
    id: c.id,
    projectId: c.projectId,
    name: c.name,
    description: c.description,
    filter: c.filter,
    ownerUserId: c.ownerUserId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function cohortEventData(c: PanelCohort) {
  return { id: c.id, projectId: c.projectId, name: c.name };
}

export async function listCohorts(db: Database, projectId?: string): Promise<PanelCohort[]> {
  const conds: SQL[] = [isNull(panelCohorts.deletedAt)];
  if (projectId) conds.push(eq(panelCohorts.projectId, projectId));
  return db.select().from(panelCohorts).where(and(...conds)).orderBy(asc(panelCohorts.name)).limit(500);
}

export async function getCohort(db: Database, id: string): Promise<PanelCohort | null> {
  const [row] = await db.select().from(panelCohorts).where(and(eq(panelCohorts.id, id), isNull(panelCohorts.deletedAt))).limit(1);
  return row ?? null;
}

export async function createCohort(db: Database, input: CreatePanelCohortInput, userId: string): Promise<PanelCohort> {
  const [row] = await db
    .insert(panelCohorts)
    .values({
      id: generateId('pnc'),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      filter: input.filter as unknown as Record<string, unknown>,
      ownerUserId: userId,
    })
    .returning();
  return row as PanelCohort;
}

export async function updateCohort(db: Database, id: string, input: UpdatePanelCohortInput): Promise<PanelCohort | null> {
  const [row] = await db
    .update(panelCohorts)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.filter !== undefined && { filter: input.filter as unknown as Record<string, unknown> }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelCohorts.id, id), isNull(panelCohorts.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteCohort(db: Database, id: string): Promise<PanelCohort | null> {
  const [row] = await db
    .update(panelCohorts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelCohorts.id, id), isNull(panelCohorts.deletedAt)))
    .returning();
  return row ?? null;
}
