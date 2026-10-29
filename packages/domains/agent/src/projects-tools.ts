/**
 * WeldAgent read tools for WeldFlow projects.
 *
 * Counts are computed on read (`@weldsuite/flow-domain/project-stats`): the
 * denormalised counter columns on `projects` are never maintained, so reading
 * them would answer "0 tasks" for every project.
 *
 * Row-level scope: when the tools act for a person (`ctx.rowScope`) and they
 * lack `projects:scope:all`, only the projects they manage or belong to are
 * visible, the same boundary WeldFlow applies. Workspace agents have no row
 * scope: their grants alone decide.
 */

import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { getProjectStats, type ProjectStats } from '@weldsuite/flow-domain/project-stats';
import { accessibleProjectIds, memberNames } from './read-helpers';
import type { PlatformToolDefinition, ToolContext } from './tools';

const listProjectsParams = z.object({
  search: z.string().max(200).optional().describe('Part of the project name or key'),
  status: z
    .string()
    .max(50)
    .optional()
    .describe('Project status such as Planning, Active or Completed (not case sensitive)'),
  limit: z.number().int().min(1).max(50).optional(),
});

const getProjectParams = z.object({
  id: z.string().min(1).max(255).optional().describe('The project id, from list_projects'),
  name: z.string().min(1).max(255).optional().describe('The project name, when you do not have its id'),
});

const DESCRIPTION_MAX_CHARS = 500;

/** `null` when the person sees every project; otherwise the project ids they may see. */
async function visibleProjectIds(ctx: ToolContext): Promise<string[] | null> {
  if (!ctx.rowScope || ctx.rowScope.allProjects) return null;
  return accessibleProjectIds(ctx.db, ctx.rowScope.userId);
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function taskCounts(stats: ProjectStats | undefined) {
  return {
    openTasks: stats?.openTasks ?? 0,
    completedTasks: stats?.completedTasks ?? 0,
    totalTasks: stats?.totalTasks ?? 0,
    progressPercent: Math.round(Number(stats?.progress ?? 0)),
  };
}

export const PROJECT_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'projects.list',
    name: 'list_projects',
    description:
      'List WeldFlow projects with their status and how many tasks are open, done and in total. ' +
      'Use it to find a project by name, or to answer questions about how many tasks a project has.',
    requiredPermissions: ['projects:read'],
    parameters: listProjectsParams,
    async execute(ctx, raw) {
      const args = listProjectsParams.parse(raw);
      const { projects: p } = schema;
      const conditions: SQL[] = [isNull(p.deletedAt)];
      const visible = await visibleProjectIds(ctx);
      if (visible) {
        if (visible.length === 0) return { totalCount: 0, projects: [] };
        conditions.push(inArray(p.id, visible));
      }
      if (args.status) conditions.push(sql`lower(${p.status}) = lower(${args.status})`);
      if (args.search) {
        const like = `%${args.search}%`;
        conditions.push(or(ilike(p.name, like), ilike(p.key, like), ilike(p.code, like))!);
      }
      const where = and(...conditions);

      const [rows, [{ total }]] = await Promise.all([
        ctx.db
          .select({
            id: p.id,
            name: p.name,
            key: p.key,
            status: p.status,
            priority: p.priority,
            health: p.health,
            startDate: p.startDate,
            endDate: p.endDate,
          })
          .from(p)
          .where(where)
          .orderBy(desc(p.updatedAt))
          .limit(args.limit ?? 20),
        ctx.db.select({ total: sql<number>`count(*)::int` }).from(p).where(where),
      ]);
      const stats = await getProjectStats(
        ctx.db,
        rows.map((row) => row.id),
      );
      return {
        totalCount: Number(total),
        projects: rows.map((row) => ({
          id: row.id,
          name: row.name,
          key: row.key,
          status: row.status,
          priority: row.priority,
          health: row.health,
          startDate: toIso(row.startDate),
          endDate: toIso(row.endDate),
          ...taskCounts(stats.get(row.id)),
        })),
      };
    },
  },
  {
    id: 'projects.get',
    name: 'get_project',
    description:
      'Get one WeldFlow project: status, dates, manager, description and its task and milestone counts. ' +
      'Pass its id (from list_projects) or its name.',
    requiredPermissions: ['projects:read'],
    parameters: getProjectParams,
    async execute(ctx, raw) {
      const args = getProjectParams.parse(raw);
      if (!args.id && !args.name) return { error: 'Give the project id or its name.' };
      const { projects: p } = schema;
      const conditions: SQL[] = [isNull(p.deletedAt)];
      const visible = await visibleProjectIds(ctx);
      if (visible) {
        if (visible.length === 0) return { error: 'Project not found' };
        conditions.push(inArray(p.id, visible));
      }
      if (args.id) conditions.push(eq(p.id, args.id));
      else conditions.push(ilike(p.name, `%${args.name}%`));

      const rows = await ctx.db
        .select()
        .from(p)
        .where(and(...conditions))
        // An exact name leads, so it is among the few rows read however many projects partly match.
        .orderBy(...(args.name ? [sql`(lower(${p.name}) = lower(${args.name})) desc`, desc(p.updatedAt)] : [desc(p.updatedAt)]))
        .limit(6);
      if (rows.length === 0) return { error: 'Project not found' };

      // A name can match several projects; an exact (case-insensitive) match wins.
      const exact = args.name ? rows.filter((row) => row.name.toLowerCase() === args.name!.toLowerCase()) : [];
      const candidates = exact.length > 0 ? exact : rows;
      if (candidates.length > 1) {
        return {
          error: 'Several projects match that name; ask the user which one they mean.',
          matches: candidates.map((row) => ({ id: row.id, name: row.name, status: row.status })),
        };
      }
      const project = candidates[0];
      const [stats, managers] = await Promise.all([
        getProjectStats(ctx.db, [project.id]),
        memberNames(ctx.db, [project.projectManagerId]),
      ]);
      const detail = stats.get(project.id);
      return {
        id: project.id,
        name: project.name,
        key: project.key,
        status: project.status,
        priority: project.priority,
        health: project.health,
        description: project.description ? project.description.slice(0, DESCRIPTION_MAX_CHARS) : null,
        manager: project.projectManagerId ? (managers.get(project.projectManagerId) ?? null) : null,
        startDate: toIso(project.startDate),
        endDate: toIso(project.endDate),
        totalMilestones: detail?.totalMilestones ?? 0,
        completedMilestones: detail?.completedMilestones ?? 0,
        ...taskCounts(detail),
      };
    },
  },
];
