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
   * Named for the capability, not the vendor: the connector provider is a
   * configuration choice (see docs/decisions/nango-connector-framework.md), and
   * baking "nango" into the event catalog would make swapping it a breaking
   * change for every workflow trigger and agent subscription.
   *
   * `connected` / `disconnected` are the lifecycle transitions worth acting on
   * — "Salesforce stopped syncing" is the automation people actually want.
   * `sync_started` fires on a manual sync, not on Nango's own schedule.
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
