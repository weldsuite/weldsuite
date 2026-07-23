import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../../../db';
import { registerEntityProvider, type EntityChannelProvider } from '../registry';

export const taskEntityProvider: EntityChannelProvider = {
  type: 'task',
  label: 'Tasks',
  requiredPermission: 'messages:read',

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

  async canAccess({ db, actingUserId, entityId }) {
    const { tasks } = schema;
    const [task] = await db
      .select({
        id: tasks.id,
        assigneeId: tasks.assigneeId,
        assigneeIds: tasks.assigneeIds,
        reporterId: tasks.reporterId,
        watchers: tasks.watchers,
        projectId: tasks.projectId,
      })
      .from(tasks)
      .where(and(eq(tasks.id, entityId), isNull(tasks.deletedAt)))
      .limit(1);

    if (!task) return false;

    if (task.assigneeId === actingUserId) return true;
    if (task.reporterId === actingUserId) return true;
    if ((task.assigneeIds ?? []).includes(actingUserId)) return true;
    if ((task.watchers ?? []).includes(actingUserId)) return true;

    if (task.projectId) {
      const { projectMembers } = schema;
      const [member] = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, actingUserId)))
        .limit(1);
      if (member) return true;
    }

    return false;
  },
};

registerEntityProvider(taskEntityProvider);
