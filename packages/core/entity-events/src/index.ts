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

// Hub subscriber registry (Phase 1+)
export {
  defineEntityEventSubscribers,
  topicMatches,
  matchEntityEventSubscribers,
  ENTITY_EVENT_SUBSCRIBERS,
  type EntityEventTopicPattern,
  type EntityEventSubscriberQueueBinding,
  type EntityEventSubscriber,
} from './subscribers';

// Workflow dispatch (entity_event + integration_event matchers)
export {
  matchAndDispatchWorkflowTriggers,
  matchAndDispatchIntegrationTriggers,
  integrationTriggerMatches,
  evalFilters,
  workflowInstanceIdForEvent,
  type MatchAndDispatchInput,
  type MatchAndDispatchIntegrationInput,
  type WorkflowDispatchEnv,
} from './workflow-dispatch';

// WeldAgent event dispatch hook (app-api registers the runner)
export {
  registerWeldAgentEventRunner,
  getWeldAgentEventRunner,
  runRegisteredWeldAgentDispatch,
  type WeldAgentEventPayload,
  type WeldAgentEventRunner,
} from './agent-dispatch';

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
  type ExtraEntityTypes,
} from './events';

// WorkspaceHub ACL topics (catalog-driven member/viewer subscribe allow-list)
export {
  PERSONAL_HUB_TOPIC_PREFIXES,
  EXTRA_MEMBER_HUB_TOPICS,
  listMemberHubEntityTopics,
  listMemberHubTopics,
} from './hub-topics';

// WeldObjects — runtime-defined custom object entity types
export {
  publishCustomObjectEvent,
  publishCustomObjectEventRaw,
  customObjectEntityKey,
  customObjectSlugFromEntityKey,
  isCustomObjectEntityKey,
  listCustomObjectEvents,
  customObjectEntityTypes,
  CUSTOM_OBJECT_ENTITY_KEY_PREFIX,
  CUSTOM_OBJECT_SLUG_MAX_LENGTH,
  CUSTOM_OBJECT_SLUG_PATTERN,
  CUSTOM_OBJECT_ACTIONS,
  type CustomObjectAction,
  type PublishCustomObjectEventParams,
  type PublishCustomObjectEventRawParams,
} from './custom-objects';

// Outbound customer webhooks (external_webhooks subscriptions)
export {
  deliverWebhookEvent,
  dispatchWebhookDeliveries,
  hasExistingWebhookDelivery,
  retryFailedWebhookDeliveries,
  signWebhookPayload,
  type WebhookRow,
  type DeliverWebhookEventInput,
  type DeliverWebhookEventResult,
  type DispatchWebhookDeliveriesInput,
  type RetryFailedWebhookDeliveriesResult,
} from './webhook-delivery';
