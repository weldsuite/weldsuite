/**
 * Asana integration — create/update tasks. Auth: Personal Access Token.
 */

import type { IntegrationDef } from '../types';

export const asana: IntegrationDef = {
  id: 'asana',
  type: 'asana',
  label: 'Asana',
  description: 'Create and update Asana tasks from your workflows.',
  category: 'productivity',
  icon: 'check-circle',
  auth: {
    kind: 'api_key',
    fields: [{ key: 'token', label: 'Personal Access Token', secret: true, placeholder: '1/...' }],
  },
  actions: [
    {
      id: 'asana.create_task',
      name: 'Create Task',
      description: 'Create a task in a project or workspace.',
      inputs: [
        { key: 'name', label: 'Task name', type: 'string', required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
        { key: 'projectId', label: 'Project ID', type: 'string', required: false },
        { key: 'workspaceId', label: 'Workspace ID (if no project)', type: 'string', required: false },
        { key: 'assignee', label: 'Assignee (user gid or email)', type: 'string', required: false },
        { key: 'dueOn', label: 'Due date (YYYY-MM-DD)', type: 'string', required: false },
      ],
    },
    {
      id: 'asana.update_task',
      name: 'Update Task',
      description: 'Update fields on an existing task.',
      inputs: [
        { key: 'taskId', label: 'Task ID', type: 'string', required: true },
        { key: 'name', label: 'Task name', type: 'string', required: false },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
        { key: 'completed', label: 'Completed', type: 'boolean', required: false },
        { key: 'dueOn', label: 'Due date (YYYY-MM-DD)', type: 'string', required: false },
      ],
    },
  ],
  triggers: [],
};
