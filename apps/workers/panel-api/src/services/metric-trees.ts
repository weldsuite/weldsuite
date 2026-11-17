/**
 * Metric trees: an output metric and the input metrics that drive it, each
 * node a saved trends report or an inline single-series trends spec. Same
 * visibility rule as reports (./saved-objects `canSee` / `canChange`). The
 * values are computed by `POST /api/panel/metric-tree-values` (query engine).
 */

import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelMetricTree, PanelReport } from '@weldsuite/db/schema';
import {
  panelMetricTreeNodesSchema,
  type CreatePanelMetricTreeInput,
  type PanelMetricTreeDto,
  type ParsedPanelMetricTreeNode,
  type UpdatePanelMetricTreeInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { canSee, type Actor, type Scope } from './saved-objects';

const { panelMetricTrees, panelReports } = schema;

export function toMetricTreeDto(t: PanelMetricTree): PanelMetricTreeDto {
  const nodes = panelMetricTreeNodesSchema.safeParse(t.nodes);
  return {
    id: t.id,
    projectId: t.projectId,
    name: t.name,
    description: t.description,
    nodes: nodes.success ? nodes.data : [],
    ownerUserId: t.ownerUserId,
    visibility: t.visibility,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_metric_tree` event: never the nodes. */
export function metricTreeEventData(t: PanelMetricTree) {
  return { id: t.id, projectId: t.projectId, name: t.name, visibility: t.visibility };
}

/**
 * Why the nodes cannot belong to a tree of `projectId` for `actor`, or null:
 * every saved report must be a trends report of the project the actor may
 * see, every inline spec must be for the project.
 */
export async function nodesProblem(db: Database, projectId: string, nodes: readonly ParsedPanelMetricTreeNode[], actor: Actor): Promise<string | null> {
  for (const node of nodes) {
    if ('spec' in node.metric && node.metric.spec.projectId !== projectId) return `Node "${node.id}" measures another project`;
  }
  const reportIds = [...new Set(nodes.flatMap((n) => ('reportId' in n.metric ? [n.metric.reportId] : [])))];
  if (reportIds.length === 0) return null;
  const reports: PanelReport[] = await db
    .select()
    .from(panelReports)
    .where(and(inArray(panelReports.id, reportIds), isNull(panelReports.deletedAt)));
  const byId = new Map(reports.map((r) => [r.id, r]));
  for (const id of reportIds) {
    const report = byId.get(id);
    if (!report || report.projectId !== projectId || !canSee(report, actor)) return `Report ${id} was not found`;
    if (report.kind !== 'trends') return `Report ${id} is not a trends report`;
  }
  return null;
}

export async function listMetricTrees(db: Database, actor: Actor, params: { projectId?: string; scope?: Scope }): Promise<PanelMetricTree[]> {
  const scope = params.scope ?? 'all';
  const conds: SQL[] = [isNull(panelMetricTrees.deletedAt)];
  if (scope === 'mine') conds.push(eq(panelMetricTrees.ownerUserId, actor.userId));
  if (scope === 'shared') conds.push(eq(panelMetricTrees.visibility, 'workspace'));
  if (params.projectId) conds.push(eq(panelMetricTrees.projectId, params.projectId));
  const rows = await db.select().from(panelMetricTrees).where(and(...conds)).orderBy(desc(panelMetricTrees.updatedAt)).limit(500);
  return rows.filter((t) => canSee(t, actor));
}

export async function getMetricTree(db: Database, id: string): Promise<PanelMetricTree | null> {
  const [row] = await db.select().from(panelMetricTrees).where(and(eq(panelMetricTrees.id, id), isNull(panelMetricTrees.deletedAt))).limit(1);
  return row ?? null;
}

export async function createMetricTree(db: Database, input: CreatePanelMetricTreeInput, userId: string): Promise<PanelMetricTree> {
  const [row] = await db
    .insert(panelMetricTrees)
    .values({
      id: generateId('pnmt'),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      nodes: panelMetricTreeNodesSchema.parse(input.nodes) as unknown as Record<string, unknown>[],
      ownerUserId: userId,
      visibility: input.visibility ?? 'private',
    })
    .returning();
  return row as PanelMetricTree;
}

export async function updateMetricTree(db: Database, id: string, input: UpdatePanelMetricTreeInput): Promise<PanelMetricTree | null> {
  const [row] = await db
    .update(panelMetricTrees)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.visibility !== undefined && { visibility: input.visibility }),
      ...(input.nodes !== undefined && { nodes: panelMetricTreeNodesSchema.parse(input.nodes) as unknown as Record<string, unknown>[] }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelMetricTrees.id, id), isNull(panelMetricTrees.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteMetricTree(db: Database, id: string): Promise<PanelMetricTree | null> {
  const [row] = await db
    .update(panelMetricTrees)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelMetricTrees.id, id), isNull(panelMetricTrees.deletedAt)))
    .returning();
  return row ?? null;
}
