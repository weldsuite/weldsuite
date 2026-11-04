/**
 * Assignment notification dispatcher for WeldFlow tasks: the in-app, push and
 * (if enabled) email notification an assignee gets when a task is created for
 * them or assigned to them. Used by the task routes and by the RAID log's
 * "create mitigation task" (`POST /api/project-raid/:id/tasks`), so a task
 * created from a register item notifies its assignee like any other task.
 */

import { eq } from 'drizzle-orm';
import { sendTaskAssignmentNotification } from '@weldsuite/notifications';
import { getMasterDb, masterSchema, schema } from '@weldsuite/worker-kit/db';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import type { Env } from '../types';

export function dispatchAssignmentNotifications(
  c: {
    env: Env;
    executionCtx: ExecutionContext;
    get: (k: 'tenantDb' | 'userId' | 'workspaceId' | 'clerkOrgId') => any;
  },
  opts: {
    assigneeIds: string[];
    taskId: string;
    taskTitle: string;
    projectId: string | null;
    taskPriority?: string | null;
    dueDate?: Date | string | null;
    taskDescription?: string | null;
  },
): void {
  if (opts.assigneeIds.length === 0) return;

  const db = c.get('tenantDb');
  const userId = c.get('userId');
  // sendTaskAssignmentNotification builds the app links and persists with the Clerk org id.
  const clerkOrgId = c.get('clerkOrgId');
  const category: 'projects' | 'crm' = opts.projectId ? 'projects' : 'crm';
  // Web in-app opens the task itself via the stable `/weldflow/task/{id}` link
  // (it resolves the project and opens the panel); mobile push uses
  // projectId/taskId from the Expo data payload for a direct
  // `/task/{projectId}/{taskId}` deep link.
  const actionUrl = opts.projectId
    ? `/weldflow/task/${opts.taskId}`
    : `/weldcrm/tasks`;

  const enrichment = (async () => {
    const [projectName, workspaceName] = await Promise.all([
      opts.projectId
        ? db
            .select({ name: schema.projects.name })
            .from(schema.projects)
            .where(eq(schema.projects.id, opts.projectId))
            .limit(1)
            .then((rows: { name: string | null }[]) => rows[0]?.name ?? null)
            .catch(() => null)
        : Promise.resolve(null),
      (async () => {
        try {
          const masterDb = getMasterDb(c.env);
          const [row] = await masterDb
            .select({ name: masterSchema.workspaces.name })
            .from(masterSchema.workspaces)
            .where(matchWorkspaceRef(c.get('workspaceId')))
            .limit(1);
          return row?.name ?? null;
        } catch {
          return null;
        }
      })(),
    ]);
    return { projectName, workspaceName };
  })();

  for (const assigneeId of opts.assigneeIds) {
    c.executionCtx.waitUntil(
      enrichment
        .then(({ projectName, workspaceName }) =>
          sendTaskAssignmentNotification({
            db,
            env: c.env,
            workspaceId: clerkOrgId,
            assigneeId,
            assignedByUserId: userId,
            taskId: opts.taskId,
            taskTitle: opts.taskTitle,
            category,
            actionUrl,
            projectId: opts.projectId,
            projectName,
            taskPriority: opts.taskPriority ?? null,
            dueDate: opts.dueDate ?? null,
            taskDescription: opts.taskDescription ?? null,
            workspaceName,
          }),
        )
        .catch((err) =>
          console.error('[app-api/tasks] assignment notification failed:', err),
        ),
    );
  }
}

