/**
 * Workflow execution statistics. Ported from api-worker `updateWorkflowStats`.
 */

import { eq } from 'drizzle-orm';
import { schema } from '../db';
import type { WorkflowDb } from './types';

export async function updateWorkflowStats(
  db: WorkflowDb,
  workflowId: string,
  success: boolean,
  source?: 'task' | 'helpdesk',
): Promise<void> {
  const table = source === 'helpdesk' ? schema.helpdeskWorkflows : schema.workflows;
  const [workflow] = (await db.select().from(table).where(eq(table.id, workflowId)).limit(1)) as any[];
  if (!workflow) return;

  await db
    .update(table)
    .set({
      executionCount: (workflow.executionCount || 0) + 1,
      successCount: success ? (workflow.successCount || 0) + 1 : workflow.successCount,
      failureCount: !success ? (workflow.failureCount || 0) + 1 : workflow.failureCount,
      lastExecutedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(table.id, workflowId));
}
