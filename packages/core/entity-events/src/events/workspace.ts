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
  /**
   * A tenant's connection to a third-party app through the connector
   * framework (WeldConnect › Connectors).
   *
   * Named for the capability, not the vendor — which is why replacing the
   * third-party connector service with our own framework
   * (docs/decisions/connector-framework.md) changed no event name and broke no
   * workflow trigger or agent subscription. Keep it that way.
   *
   * `connected` / `disconnected` are the lifecycle transitions worth acting on
   * — "Moneybird stopped syncing" is the automation people actually want.
   * `sync_started` fires on a manual sync, not on the scheduler's sweep.
   */
  connector_connection: [
    'created',
    'updated',
    'deleted',
    'connected',
    'disconnected',
    'paused',
    'resumed',
    'sync_started',
    'auth_error',
  ],
} as const;
