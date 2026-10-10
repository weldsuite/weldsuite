/**
 * Task-assignment notification — fires when a user is added as the assignee
 * of a task (project task or CRM task). Its email renders with the richer
 * `task.assigned` template (@weldsuite/emails).
 *
 * Skips self-assignment.
 */

import { eq, isNull } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

interface TaskAssignmentParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  assigneeId: string;
  assignedByUserId: string;
  taskId: string;
  taskTitle: string;
  category: 'projects' | 'task' | 'crm';
  /** Relative action path, e.g. `/weldflow/task/task_abc123`. Prefixed
   *  with `env.PUBLIC_APP_URL` for the absolute link in the email
   *  template; in-app + push keep it as a path. */
  actionUrl: string;
  /** WeldFlow project id — included in the Expo push `data` payload so the
   *  mobile app can deep-link to `/task/{projectId}/{taskId}`. */
  projectId?: string | null;
  /** Optional enrichments surfaced on the `task.assigned` email template.
   *  Missing values are simply omitted so the template still renders. */
  projectName?: string | null;
  taskPriority?: string | null;
  dueDate?: Date | string | null;
  taskDescription?: string | null;
  workspaceName?: string | null;
}

export async function sendTaskAssignmentNotification<Env extends NotificationEnv>(
  params: TaskAssignmentParams<Env>,
): Promise<string | null> {
  const {
    db,
    env,
    workspaceId,
    assigneeId,
    assignedByUserId,
    taskId,
    taskTitle,
    category,
    actionUrl,
    projectId,
    projectName,
    taskPriority,
    dueDate,
    taskDescription,
  } = params;

  if (assigneeId === assignedByUserId) {
    return null;
  }

  // ISO date-time for the `task.assigned` template, which formats it in the
  // recipient's locale + the workspace timezone.
  let dueDateIso: string | undefined;
  if (dueDate instanceof Date) dueDateIso = dueDate.toISOString();
  else if (typeof dueDate === 'string' && dueDate) dueDateIso = dueDate;

  // Resolve assigner name + the workspace timezone for the email template.
  // Tolerant of misses: defaults keep the email renderable.
  let assignerName = 'Someone';
  try {
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, assignedByUserId));
    if (members[0]?.name) assignerName = members[0].name;
  } catch (err) {
    console.error('[Notifications] Failed to resolve assigner name:', err);
  }
  let timezone: string | undefined;
  try {
    const [wsSettings] = await db
      .select({ timezone: schema.workspaceSettings.timezone })
      .from(schema.workspaceSettings)
      .where(isNull(schema.workspaceSettings.deletedAt))
      .limit(1);
    if (wsSettings?.timezone) timezone = wsSettings.timezone;
  } catch {
    // non-fatal — the template falls back to UTC.
  }

  const baseUrl = env.PUBLIC_APP_URL ?? '';
  const absoluteUrl = baseUrl ? `${baseUrl}${actionUrl}` : actionUrl;

  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: assigneeId,
    title: 'Task assigned to you',
    body: `${assignerName} assigned "${taskTitle}" to you`,
    category,
    notificationType: 'task_assigned',
    entityType: 'task',
    entityId: taskId,
    actionUrl,
    severity: 'info',
    actorType: 'user',
    actorId: assignedByUserId,
    data: {
      taskId,
      ...(projectId ? { projectId } : {}),
    },
    email: {
      template: 'task.assigned',
      props: {
        assignerName,
        taskTitle,
        projectName,
        priority: taskPriority,
        dueDate: dueDateIso,
        timezone,
        description: taskDescription,
        taskUrl: absoluteUrl,
        settingsUrl: baseUrl ? `${baseUrl}/settings/notifications` : undefined,
      },
    },
  });
}
