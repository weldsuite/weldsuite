/**
 * Cross-cutting workspace entity events — notifications, workflows,
 * settings.
 */
export const WORKSPACE_ENTITY_EVENTS = {
  notification: ['created', 'updated', 'deleted'],
  notification_template: ['created', 'updated', 'deleted'],
  digest_settings: ['updated'],
  workflow: ['created', 'updated', 'deleted', 'archived'],
  workflow_execution: ['created', 'updated', 'started', 'completed', 'cancelled'],
  workflow_integration: ['created', 'updated', 'deleted'],
  workflow_schedule: ['created', 'updated', 'deleted'],
  workflow_template: ['created', 'updated', 'deleted'],
  workflow_trigger: ['created', 'updated', 'deleted'],
  workflow_variable: ['created', 'updated', 'deleted'],
  workflow_webhook: ['created', 'updated', 'deleted'],
  workspace_settings: ['updated', 'deleted'],
} as const;
