/**
 * WeldFlow task action: create_task.
 *
 * Like create_contact/create_customer, this never writes the tenant `tasks`
 * table directly: it calls connect-api's internal workflow-action route
 * (over the `CONNECT_INTERNAL` entrypoint), which checks the workflow
 * owner's permissions AND their write access to the target project, then
 * goes through `@weldsuite/flow-domain`'s task service and publishes the
 * `project_task:created` entity event. The run's chain depth goes along so
 * the event can't retrigger workflows forever.
 */

import type { ActionHandler } from '../types';
import { NonRetryableStepError } from '../errors';
import { optionalText, postInternalApi, workflowActor } from './helpers';

/** Wire contract with connect-api's create-task route. */
export interface CreateTaskActionResponse {
  success: boolean;
  task: {
    id: string;
    number: number | null;
    projectId: string | null;
    title: string;
  };
}

/** A comma-separated list (or an array) as trimmed, non-empty strings. */
function textList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
  const list = items.map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * `today` / `tomorrow` / `in 3 days` / `in 1 week` / `in 2 hours` — the
 * editor's quick-pick helper writes one of these into the due-date field so
 * a recurring workflow always schedules the task relative to the moment the
 * step actually runs, instead of baking in a fixed date at configuration
 * time. Anything else (an ISO date string, or a `{{variable}}` the engine
 * already resolved to one) is passed through unchanged.
 */
const RELATIVE_DUE_DATE = /^in\s+(\d+)\s*(hours?|h|days?|d|weeks?|w)$/i;

const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function resolveDueDate(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (lower === 'today') return new Date().toISOString();
  if (lower === 'tomorrow') return new Date(Date.now() + UNIT_MS.d).toISOString();
  const match = RELATIVE_DUE_DATE.exec(text);
  if (!match) return text;
  const amount = Number(match[1]);
  const unitMs = UNIT_MS[match[2]!.charAt(0).toLowerCase()] ?? UNIT_MS.d;
  return new Date(Date.now() + amount * unitMs).toISOString();
}

export const handleCreateTask: ActionHandler = async (inputs, ctx) => {
  const projectId = optionalText(inputs.projectId);
  if (!projectId) throw new NonRetryableStepError('Choose the project to create the task in');
  const title = optionalText(inputs.title);
  if (!title) throw new NonRetryableStepError('A task needs a title');

  const result = await postInternalApi<CreateTaskActionResponse>(
    ctx.env,
    '/workflow-actions/create-task',
    {
      ...workflowActor(ctx),
      projectId,
      task: {
        title,
        description: optionalText(inputs.description),
        priority: optionalText(inputs.priority),
        stageId: optionalText(inputs.stageId),
        assigneeIds: textList(inputs.assigneeIds ?? inputs.assigneeId),
        dueDate: resolveDueDate(inputs.dueDate),
        labels: textList(inputs.labels),
        tags: textList(inputs.tags),
      },
    },
    'Create task',
    'CONNECT_INTERNAL',
  );

  const { task } = result;
  return {
    taskId: task.id,
    number: task.number,
    key: task.number != null ? String(task.number) : null,
    projectId: task.projectId,
    title: task.title,
    url: task.projectId ? `/weldflow/task/${task.id}` : null,
  };
};
