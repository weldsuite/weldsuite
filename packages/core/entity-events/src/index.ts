/**
 * @weldsuite/entity-events — entity-event publishing for WeldSuite.
 *
 * Re-exports the publisher orchestrator + types + change detection +
 * events catalog. Consumer workers should import the type-only surface
 * from `@weldsuite/entity-events/types` instead.
 */

// Wire-format types
export type {
  EntityEventMessage,
  EntityAction,
  EventSource,
} from './types';

// Change detection
export { computeChanges } from './changes';

// Publisher (orchestrator)
export {
  publishEntityEvent,
  publishEntityEventRaw,
  type PublishEntityEventParams,
  type PublishEntityEventRawParams,
  type EntityEventPublisherEnv,
  type EntityEventPublisherVariables,
} from './publisher';

// Workflow dispatch (exported for advanced use; the publisher already wires it in)
export {
  matchAndDispatchWorkflowTriggers,
  matchAndDispatchIntegrationTriggers,
  integrationTriggerMatches,
  evalFilters,
  type MatchAndDispatchInput,
  type MatchAndDispatchIntegrationInput,
  type WorkflowDispatchEnv,
} from './workflow-dispatch';

// Events catalog
export {
  ENTITY_EVENTS,
  type EntityType,
  type ActionFor,
  type EventName,
  type EventNameDotted,
  type EntityEventData,
  type DataFor,
  isKnownEntityType,
  isKnownAction,
  isValidSubscription,
  listAllEvents,
  listAllWireEvents,
  parseEventName,
} from './events';

// Outbound customer webhooks (external_webhooks subscriptions)
export {
  deliverWebhookEvent,
  dispatchWebhookDeliveries,
  retryFailedWebhookDeliveries,
  signWebhookPayload,
  type WebhookRow,
  type DeliverWebhookEventInput,
  type DeliverWebhookEventResult,
  type DispatchWebhookDeliveriesInput,
  type RetryFailedWebhookDeliveriesResult,
} from './webhook-delivery';
