import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';

/**
 * Of `projectIds`, the ones `userId` may open, by flow-api's read rule
 * (`mayAccess` over flow-domain's `resolveProjectAccess`): the project is not
 * soft-deleted, and the user holds `projects:scope:all`, manages the project or
 * is an active member of it. A deleted project is closed to scope:all as well.
 */
async function openProjectIds(
  db: Database,
  userId: string,
  projectIds: string[],
  scopeAll: boolean,
): Promise<Set<string>> {
  const { projects, projectMembers } = schema;
  const live = await db
    .select({ id: projects.id, projectManagerId: projects.projectManagerId })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)));

  const open = new Set<string>();
  const others: string[] = [];
  for (const project of live) {
    if (scopeAll || project.projectManagerId === userId) open.add(project.id);
    else others.push(project.id);
  }
  if (others.length === 0) return open;

  const memberOf = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(
      and(
        inArray(projectMembers.projectId, others),
        eq(projectMembers.userId, userId),
        // Removing someone from a project only deactivates their row.
        eq(projectMembers.isActive, true),
        isNull(projectMembers.deletedAt),
      ),
    );
  for (const m of memberOf) open.add(m.projectId);
  return open;
}

export const taskEntityProvider: EntityChannelProvider = {
  type: 'task',
  label: 'Tasks',
  requiredPermission: 'tasks:read',

  async resolve({ db, entityId }) {
    const { tasks } = schema;
    const [task] = await db
      .select({
        title: tasks.title,
        assigneeId: tasks.assigneeId,
        assigneeIds: tasks.assigneeIds,
        reporterId: tasks.reporterId,
        watchers: tasks.watchers,
      })
      .from(tasks)
      .where(and(eq(tasks.id, entityId), isNull(tasks.deletedAt)))
      .limit(1);

    if (!task) return null;

    const members = new Set<string>();
    if (task.assigneeId) members.add(task.assigneeId);
    for (const id of task.assigneeIds ?? []) members.add(id);
    if (task.reporterId) members.add(task.reporterId);
    for (const id of task.watchers ?? []) members.add(id);

    return {
      displayName: task.title,
      defaultMemberIds: Array.from(members),
    };
  },

  async resolveDetail({ db, entityId }) {
    const { tasks } = schema;
    const [task] = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        type: tasks.type,
        assigneeId: tasks.assigneeId,
        assigneeIds: tasks.assigneeIds,
        reporterId: tasks.reporterId,
        projectId: tasks.projectId,
        startDate: tasks.startDate,
        dueDate: tasks.dueDate,
        tags: tasks.tags,
        labels: tasks.labels,
      })
      .from(tasks)
      .where(and(eq(tasks.id, entityId), isNull(tasks.deletedAt)))
      .limit(1);
    return task ?? null;
  },

  /**
   * A project task opens exactly as it does in WeldFlow (`GET /tasks/:id`): to
   * those who may open its project, whatever their part in the task itself. A
   * task assignee, reporter or watcher removed from a private project, or one of
   * a deleted project, does not see it. Only a task without a project falls back
   * to the people involved in it.
   */
  async filterVisible({ db, actingUserId, can }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { tasks } = schema;
    const rows = await db
      .select({
        id: tasks.id,
        assigneeId: tasks.assigneeId,
        assigneeIds: tasks.assigneeIds,
        reporterId: tasks.reporterId,
        watchers: tasks.watchers,
        projectId: tasks.projectId,
      })
      .from(tasks)
      .where(and(inArray(tasks.id, entityIds), isNull(tasks.deletedAt)));

    const visible = new Set<string>();
    const viaProject: Array<{ id: string; projectId: string }> = [];
    for (const task of rows) {
      if (task.projectId) {
        viaProject.push({ id: task.id, projectId: task.projectId });
        continue;
      }
      const involved =
        task.assigneeId === actingUserId ||
        task.reporterId === actingUserId ||
        (task.assigneeIds ?? []).includes(actingUserId) ||
        (task.watchers ?? []).includes(actingUserId);
      if (involved) visible.add(task.id);
    }

    if (viaProject.length > 0) {
      const projectIds = [...new Set(viaProject.map((t) => t.projectId))];
      const open = await openProjectIds(db, actingUserId, projectIds, await can('projects:scope:all'));
      for (const task of viaProject) if (open.has(task.projectId)) visible.add(task.id);
    }
    return visible;
  },

  canAccess(ctx) {
    return canAccessViaFilter(taskEntityProvider, ctx);
  },
};

registerEntityProvider(taskEntityProvider);
