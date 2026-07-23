/**
 * Task-assignment notification — fires when a user is added as the assignee
 * of a task (project task or CRM task). Uses a Resend template when
 * `env.RESEND_TEMPLATE_TASK_ASSIGNED` is set, otherwise plain text.
 *
 * Skips self-assignment.
 */

import { eq } from 'drizzle-orm';
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
  /** Relative action path, e.g. `/weldflow/tasks/task_abc123`. Prefixed
   *  with `env.PUBLIC_APP_URL` for the absolute link in the email
   *  template; in-app + push keep it as a path. */
  actionUrl: string;
  /** Optional template enrichments — surfaced as Resend template variables
   *  (`project_name`, `task_priority`, `due_date`, `task_description`,
   *  `company_name`). Missing values fall back to empty strings so the
   *  template still renders. */
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
    projectName,
    taskPriority,
    dueDate,
    taskDescription,
    workspaceName,
  } = params;

  if (assigneeId === assignedByUserId) {
    return null;
  }

  // Normalise optional template variables. Dates render as YYYY-MM-DD;
  // anything else becomes a plain string. Missing values stay empty so the
  // template renders cleanly without "undefined" leaking through.
  const formattedDueDate =
    dueDate instanceof Date
      ? dueDate.toISOString().slice(0, 10)
      : typeof dueDate === 'string' && dueDate
        ? dueDate.slice(0, 10)
        : '';

  // Resolve assigner + assignee display names for the template variables.
  // Tolerant of misses: defaults to "Someone" / "there" so the email still
  // renders if the lookup fails.
  let assignerName = 'Someone';
  let assigneeName = 'there';
  try {
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, assignedByUserId));
    if (members[0]?.name) assignerName = members[0].name;
  } catch (err) {
    console.error('[Notifications] Failed to resolve assigner name:', err);
  }
  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, assigneeId))
      .limit(1);
    if (member?.name) assigneeName = member.name;
  } catch {
    // non-fatal
  }

  const templateId = env.RESEND_TEMPLATE_TASK_ASSIGNED;
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
    emailTemplate: templateId
      ? {
          id: templateId,
          variables: {
            assignee_name: assigneeName,
            assigner_name: assignerName,
            task_title: taskTitle,
            task_url: absoluteUrl,
            action_url: absoluteUrl,
            project_name: projectName ?? '',
            task_priority: taskPriority ?? '',
            due_date: formattedDueDate,
            task_description: taskDescription ?? '',
            company_name: workspaceName ?? '',
          },
        }
      : undefined,
  });
}
