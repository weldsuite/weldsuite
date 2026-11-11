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
   * Core legal entities (docs/plans/legal-entities.md). Registrations count
   * as an `updated` of the entity; so does switching per-entity access on
   * or off. `accounting_entity` stays for WeldBooks' extension.
   */
  legal_entity: ['created', 'updated', 'archived', 'deleted'],
  /** Ids and masked numbers only; reveals are logged in `legal_entity_reveals`, never sent as events. */
  legal_entity_bank_account: ['created', 'updated', 'deleted'],
  /** Who may see a legal entity, and with which role (per-entity access). */
  legal_entity_member: ['created', 'updated', 'deleted'],
  /** A destination the audit log is pushed to (SIEM). Event data never carries the token, only `hasToken`. */
  audit_log_stream: ['created', 'updated', 'deleted'],
  /**
   * A tenant's connection to a third-party app through the connector
   * framework (WeldConnect › Connectors).
   *
   * Named for the capability, not a vendor: swapping the underlying client
   * (WooCommerce today, others later) must not be a breaking change for
   * workflow triggers or agent subscriptions.
   *
   * `connected` / `disconnected` are the lifecycle transitions worth acting on.
   * `sync_started` fires on a manual or initial sync.
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
