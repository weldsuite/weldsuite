/**
 * Notifications for a new task comment: @-mentioned users get a `mention`,
 * the task's assignees and reporter get a `task_comment`. Pure function of the
 * tenant DB + env, so the route only hands it the inserted comment.
 *
 * A mention only reaches someone who could open the task: an active member of
 * the workspace and, for a project task, someone with read access to that
 * project. Otherwise a mention would leak the comment text to a user outside
 * the project.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  extractMentionedUserIds,
  sendTaskCommentNotification,
  taskCommentRecipients,
} from '@weldsuite/notifications';
import { resolveProjectAccess } from '@weldsuite/flow-domain/project-access';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

interface TaskCommentNotice {
  db: Database;
  env: Env;
  /** Clerk org id. */
  workspaceId: string;
  authorId: string;
  commentId: string;
  taskId: string;
  content: string;
}

/** Mentioned ids that are active members and may read the task's project. */
async function mentionableUserIds(db: Database, userIds: string[], projectId: string | null): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { workspaceMembers } = schema;
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, userIds), sql`upper(${workspaceMembers.status}) = 'ACTIVE'`));
  const active = members.map((m) => m.userId);
  if (!projectId) return active;
  const access = await Promise.all(
    active.map(async (userId) => ((await resolveProjectAccess(db, userId, { scopeAll: false }, projectId)).canRead ? userId : null)),
  );
  return access.filter((id): id is string => id !== null);
}

export async function notifyTaskComment(notice: TaskCommentNotice): Promise<void> {
  const { db, env, workspaceId, authorId, commentId, taskId, content } = notice;

  const [task] = await db
    .select({
      title: schema.tasks.title,
      projectId: schema.tasks.projectId,
      assigneeId: schema.tasks.assigneeId,
      assigneeIds: schema.tasks.assigneeIds,
      reporterId: schema.tasks.reporterId,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), isNull(schema.tasks.deletedAt)))
    .limit(1);
  if (!task) return;

  const watcherIds = [task.assigneeId, ...(task.assigneeIds ?? []), task.reporterId].filter(
    (id): id is string => !!id,
  );
  const mentionedUserIds = await mentionableUserIds(
    db,
    extractMentionedUserIds(content).filter((id) => id !== authorId),
    task.projectId,
  );
  const { mentioned, watchers } = taskCommentRecipients({ authorId, mentionedUserIds, watcherIds });
  if (mentioned.length === 0 && watchers.length === 0) return;

  const [author] = await db
    .select({ name: schema.workspaceMembers.name })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, authorId))
    .limit(1);

  const shared = {
    db,
    env,
    workspaceId,
    authorId,
    authorName: author?.name || 'Someone',
    taskId,
    taskTitle: task.title,
    commentId,
    content,
    category: task.projectId ? ('projects' as const) : ('crm' as const),
    // Same links as the assignment notification (dispatchAssignmentNotifications).
    actionUrl: task.projectId ? `/weldflow/task/${taskId}` : '/weldcrm/tasks',
    projectId: task.projectId,
  };

  await Promise.allSettled([
    ...mentioned.map((recipientId) => sendTaskCommentNotification({ ...shared, recipientId, kind: 'mention' })),
    ...watchers.map((recipientId) => sendTaskCommentNotification({ ...shared, recipientId, kind: 'comment' })),
  ]);
}
