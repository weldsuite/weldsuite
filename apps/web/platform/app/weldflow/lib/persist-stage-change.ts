import { tasksApi } from './api-client';

/**
 * Persist a stage pick for a task. Moving into / out of 'done' goes through the
 * toggle endpoint (which handles recurrence and returns `nextTaskId` when a
 * follow-up occurrence was created), then the stage / status is saved on top.
 */
export async function persistStageChange(
  projectId: string,
  taskId: string,
  stageId: string,
  oldStatus: string,
  newStatus: string,
) {
  if (newStatus === 'done' && oldStatus !== 'done') {
    const result = await tasksApi.toggle(projectId, taskId, oldStatus);
    if (result.success) {
      // toggle only flips status; also persist the picked stageId
      await tasksApi.update(projectId, taskId, { stageId });
    }
    return result;
  }
  if (newStatus !== 'done' && oldStatus === 'done') {
    const result = await tasksApi.toggle(projectId, taskId, 'done');
    if (result.success) {
      await tasksApi.update(projectId, taskId, { stageId, status: newStatus });
    }
    return result;
  }
  return tasksApi.update(projectId, taskId, { stageId, status: newStatus });
}
