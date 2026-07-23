/**
 * Asana outbound actions (`asana.create_task`, `asana.update_task`).
 */

import type { ActionHandler } from '../../types';
import { getIntegrationCredentials } from './token';

async function asanaToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown): Promise<string> {
  const { credentials } = await getIntegrationCredentials(ctx, {
    type: 'asana',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
  if (!credentials.token) throw new Error('Asana integration has no token');
  return credentials.token;
}

export const handleAsanaCreateTask: ActionHandler = async (inputs, ctx) => {
  const name = String(inputs.name || '');
  if (!name) throw new Error('Asana task name is required');
  const projectId = inputs.projectId ? String(inputs.projectId) : undefined;
  const workspaceId = inputs.workspaceId ? String(inputs.workspaceId) : undefined;
  if (!projectId && !workspaceId) throw new Error('Asana task needs a projectId or workspaceId');

  const token = await asanaToken(ctx, inputs.integrationId);
  const data: Record<string, unknown> = {
    name,
    notes: inputs.notes ? String(inputs.notes) : undefined,
    assignee: inputs.assignee ? String(inputs.assignee) : undefined,
    due_on: inputs.dueOn ? String(inputs.dueOn) : undefined,
  };
  if (projectId) data.projects = [projectId];
  else if (workspaceId) data.workspace = workspaceId;

  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const json = (await res.json()) as { data?: { gid?: string }; errors?: Array<{ message: string }> };
  if (!res.ok) throw new Error(`Asana create failed: ${json.errors?.[0]?.message || res.status}`);
  return { created: true, id: json.data?.gid };
};

export const handleAsanaUpdateTask: ActionHandler = async (inputs, ctx) => {
  const taskId = String(inputs.taskId || '');
  if (!taskId) throw new Error('Asana taskId is required');

  const token = await asanaToken(ctx, inputs.integrationId);
  const data: Record<string, unknown> = {};
  if (inputs.name !== undefined) data.name = String(inputs.name);
  if (inputs.notes !== undefined) data.notes = String(inputs.notes);
  if (inputs.completed !== undefined) data.completed = Boolean(inputs.completed);
  if (inputs.dueOn !== undefined) data.due_on = String(inputs.dueOn);

  const res = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const json = (await res.json()) as { data?: { gid?: string }; errors?: Array<{ message: string }> };
  if (!res.ok) throw new Error(`Asana update failed: ${json.errors?.[0]?.message || res.status}`);
  return { updated: true, id: json.data?.gid };
};
