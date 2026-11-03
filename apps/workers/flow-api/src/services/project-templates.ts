/**
 * Project templates, the database side (design: weldflow-delivery-and-portfolio.md,
 * "Create from a template"; ADR FLOW-021; slice F): reading a project into a
 * blueprint, how many projects each template made, writing a planned project
 * in one batch, and the events of a new project.
 *
 * The rules (building a blueprint, checking it, planning the rows) are in
 * `@weldsuite/flow-domain/project-templates`.
 */

import type { Context } from 'hono';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { ProjectTemplate, ProjectTemplateDetail } from '@weldsuite/app-api-client/schemas/project-closing';
import {
  readBlueprint,
  summarizeStoredBlueprint,
  type BlueprintSource,
  type InstantiatePlan,
} from '@weldsuite/flow-domain/project-templates';
import { raidEventData } from '@weldsuite/flow-domain/raid';
import { taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';
import type { ProjectRow } from './project-closing';
import type { Env, Variables } from '../types';
import { projectAnalyticsPayload } from '../lib/weldflow-analytics-payload';

export type TemplateRow = typeof schema.projectTemplates.$inferSelect;

const templates = schema.projectTemplates;

/** A live template this person may see: a shared one, or their own. */
export async function findVisibleTemplate(db: Database, id: string, userId: string): Promise<TemplateRow | null> {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), isNull(templates.deletedAt)))
    .limit(1);
  if (!row) return null;
  return row.shared || row.createdBy === userId ? row : null;
}

/** How many live projects were created from each template. */
export async function usageCounts(db: Database, templateIds: string[]): Promise<Map<string, number>> {
  const usage = new Map<string, number>(templateIds.map((id) => [id, 0]));
  if (templateIds.length === 0) return usage;
  const used = sql<string>`${schema.projects.settings}->>'templateId'`;
  const rows = await db
    .select({ templateId: used, total: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.projects)
    .where(and(isNull(schema.projects.deletedAt), inArray(used, templateIds)))
    .groupBy(used);
  for (const row of rows) usage.set(row.templateId, row.total);
  return usage;
}

/** A template as the list answers it: a summary of the blueprint, not the blueprint. */
export function presentTemplate(row: TemplateRow, usageCount: number): ProjectTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    shared: row.shared,
    sourceProjectId: row.sourceProjectId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    summary: summarizeStoredBlueprint(row.blueprint),
    usageCount,
  };
}

/** A template with its blueprint, or null when the stored blueprint is not valid any more. */
export function presentTemplateDetail(row: TemplateRow, usageCount: number): ProjectTemplateDetail | null {
  const read = readBlueprint(row.blueprint);
  if (!read.ok) return null;
  return { ...presentTemplate(row, usageCount), blueprint: read.blueprint };
}

/** The payload of a `project_template` event. */
export function templateEventData(row: TemplateRow) {
  return { id: row.id, name: row.name, shared: row.shared, sourceProjectId: row.sourceProjectId };
}

// ── Save as template ────────────────────────────────────────────────────────

/** Every live row a blueprint of the project is built from. */
export async function loadBlueprintSource(db: Database, project: ProjectRow): Promise<BlueprintSource> {
  const projectId = project.id;
  const [members, stages, phases, milestones, deliverables, tasks, dependencies, raidItems] = await Promise.all([
    db
      .select()
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
        ),
      ),
    db
      .select()
      .from(schema.projectPipelineStages)
      .where(and(eq(schema.projectPipelineStages.projectId, projectId), isNull(schema.projectPipelineStages.deletedAt)))
      .orderBy(asc(schema.projectPipelineStages.position)),
    db
      .select()
      .from(schema.projectPhases)
      .where(and(eq(schema.projectPhases.projectId, projectId), isNull(schema.projectPhases.deletedAt))),
    db
      .select()
      .from(schema.milestones)
      .where(and(eq(schema.milestones.projectId, projectId), isNull(schema.milestones.deletedAt))),
    db
      .select()
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt))),
    db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), isNull(schema.tasks.deletedAt))),
    db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, projectId)),
    db
      .select()
      .from(schema.projectRaidItems)
      .where(and(eq(schema.projectRaidItems.projectId, projectId), isNull(schema.projectRaidItems.deletedAt))),
  ]);
  return { project, members, stages, phases, milestones, deliverables, tasks, dependencies, raidItems };
}

// ── Create project ──────────────────────────────────────────────────────────

/** Rows per insert statement, so a template of thousands of tasks stays under the driver's parameter limit. */
const CHUNK = 200;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += CHUNK) out.push(rows.slice(index, index + CHUNK));
  return out;
}

/**
 * The statements that write a planned project, in the order its foreign keys
 * need them (the project first, tasks before their dependencies, register items
 * before their assessments). Run them with `atomically`: the project is there
 * whole or not at all.
 */
export function planStatements(handle: Database, plan: InstantiatePlan): unknown[] {
  return [
    handle.insert(schema.projects).values(plan.project),
    ...chunks(plan.members).map((rows) => handle.insert(schema.projectMembers).values(rows)),
    ...chunks(plan.sequences).map((rows) => handle.insert(schema.taskNumberSequences).values(rows)),
    ...chunks(plan.stages).map((rows) => handle.insert(schema.projectPipelineStages).values(rows)),
    ...chunks(plan.milestones).map((rows) => handle.insert(schema.milestones).values(rows)),
    ...chunks(plan.phases).map((rows) => handle.insert(schema.projectPhases).values(rows)),
    ...chunks(plan.deliverables).map((rows) => handle.insert(schema.projectDeliverables).values(rows)),
    ...chunks(plan.tasks).map((rows) => handle.insert(schema.tasks).values(rows)),
    ...chunks(plan.dependencies).map((rows) => handle.insert(schema.taskDependencies).values(rows)),
    ...chunks(plan.raidItems).map((rows) => handle.insert(schema.projectRaidItems).values(rows)),
    ...chunks(plan.assessments).map((rows) => handle.insert(schema.projectRaidAssessments).values(rows)),
  ];
}

type EventContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Publish the `created` events of a new project, in the order its rows were
 * written: the project, its members, stages, milestones, phases, deliverables,
 * tasks, dependencies and register items.
 */
export async function publishPlannedEvents(c: EventContext, plan: InstantiatePlan): Promise<void> {
  publishEntityEvent({
    c,
    entityType: 'project',
    entityId: plan.projectId,
    action: 'created',
    data: projectAnalyticsPayload(plan.project as unknown as Record<string, unknown>),
  });
  for (const row of plan.members) {
    publishEntityEvent({
      c,
      entityType: 'project_member',
      entityId: row.id,
      action: 'added',
      data: { id: row.id, projectId: row.projectId, userId: row.userId, role: row.role },
    });
  }
  for (const row of plan.stages) {
    publishEntityEvent({
      c,
      entityType: 'project_pipeline_stage',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId: row.projectId, name: row.name },
    });
  }
  for (const row of plan.milestones) {
    publishEntityEvent({
      c,
      entityType: 'project_milestone',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId: row.projectId, name: row.name, status: 'pending' },
    });
  }
  for (const row of plan.phases) {
    publishEntityEvent({
      c,
      entityType: 'project_phase',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId: row.projectId, name: row.name, position: row.position, status: row.status },
    });
  }
  for (const row of plan.deliverables) {
    publishEntityEvent({
      c,
      entityType: 'project_deliverable',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, projectId: row.projectId, number: row.number, code: `D${row.number}`, title: row.title, status: row.status },
    });
  }
  for (const row of plan.tasks) {
    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: row.id,
      action: 'created',
      data: taskAnalyticsPayload(row as unknown as Record<string, unknown>, { projectId: plan.projectId }),
    });
  }
  for (const row of plan.dependencies) {
    publishEntityEvent({
      c,
      entityType: 'task_dependency',
      entityId: row.id,
      action: 'created',
      data: {
        id: row.id,
        projectId: row.projectId,
        predecessorId: row.predecessorId,
        successorId: row.successorId,
        type: row.type,
        lagDays: row.lagDays,
      },
    });
  }
  if (plan.raidItems.length > 0) {
    // The register events carry whole rows (score, band), so read them back as the database stored them.
    const stored = await c
      .get('tenantDb')
      .select()
      .from(schema.projectRaidItems)
      .where(eq(schema.projectRaidItems.projectId, plan.projectId));
    const byId = new Map(stored.map((row) => [row.id, row]));
    for (const planned of plan.raidItems) {
      const row = byId.get(planned.id);
      if (row) {
        publishEntityEvent({ c, entityType: 'project_raid_item', entityId: row.id, action: 'created', data: raidEventData(row) });
      }
    }
  }
}
