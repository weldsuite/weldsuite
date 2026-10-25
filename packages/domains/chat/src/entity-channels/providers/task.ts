import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';

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

  /** Assignees, the reporter and watchers, plus members of the task's project. */
  async filterVisible({ db, actingUserId }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { tasks, projectMembers } = schema;
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
      const involved =
        task.assigneeId === actingUserId ||
        task.reporterId === actingUserId ||
        (task.assigneeIds ?? []).includes(actingUserId) ||
        (task.watchers ?? []).includes(actingUserId);
      if (involved) visible.add(task.id);
      else if (task.projectId) viaProject.push({ id: task.id, projectId: task.projectId });
    }

    if (viaProject.length > 0) {
      const memberOf = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(
          and(
            inArray(projectMembers.projectId, [...new Set(viaProject.map((t) => t.projectId))]),
            eq(projectMembers.userId, actingUserId),
          ),
        );
      const projectIds = new Set(memberOf.map((m) => m.projectId));
      for (const task of viaProject) if (projectIds.has(task.projectId)) visible.add(task.id);
    }
    return visible;
  },

  canAccess(ctx) {
    return canAccessViaFilter(taskEntityProvider, ctx);
  },
};

registerEntityProvider(taskEntityProvider);
