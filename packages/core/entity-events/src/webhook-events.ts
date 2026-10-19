/**
 * Which catalog events an outbound webhook can subscribe to, and how legacy
 * event names keep working.
 *
 * The CRM renamed its objects (TASK-916): customers became companies and
 * contacts became people. Nothing publishes `customer.*` or `contact.*` any
 * more, so offering them in the webhook event picker produced subscriptions
 * that never fire. They stay in the catalog (existing webhooks, workflows and
 * agents still validate against it) but are not offered for new
 * subscriptions, and a webhook that still lists a legacy name receives the
 * event of the current entity under the name it subscribed to.
 */

import { ENTITY_EVENTS, listAllEvents, type EventNameDotted } from './events';

/** Legacy entity type → the entity type that publishes in its place. */
export const LEGACY_WEBHOOK_ENTITY_ALIASES: Readonly<Record<string, string>> = {
  customer: 'company',
  contact: 'person',
};

/** Catalog events offered to new webhook subscriptions (legacy names left out). */
export function listWebhookEvents(): readonly EventNameDotted[] {
  return listAllEvents().filter((event) => {
    const entityType = event.slice(0, event.indexOf('.'));
    return !(entityType in LEGACY_WEBHOOK_ENTITY_ALIASES);
  });
}

/**
 * Legacy event names that a webhook may have subscribed to for `eventType`
 * (`company.created` → `['customer.created']`). Only actions the legacy entity
 * actually listed are returned.
 */
export function legacyWebhookEventNames(eventType: string): string[] {
  const dot = eventType.indexOf('.');
  if (dot === -1) return [];
  const entityType = eventType.slice(0, dot);
  const action = eventType.slice(dot + 1);
  const out: string[] = [];
  for (const [legacy, current] of Object.entries(LEGACY_WEBHOOK_ENTITY_ALIASES)) {
    if (current !== entityType) continue;
    const actions = (ENTITY_EVENTS as Record<string, readonly string[]>)[legacy] ?? [];
    if (actions.includes(action)) out.push(`${legacy}.${action}`);
  }
  return out;
}

/**
 * The event name to deliver to a webhook: the current name when it subscribed
 * to it, else the legacy name it subscribed to, else null (not subscribed).
 */
export function subscribedWebhookEventName(subscribed: readonly string[], eventType: string): string | null {
  if (subscribed.includes(eventType)) return eventType;
  return legacyWebhookEventNames(eventType).find((name) => subscribed.includes(name)) ?? null;
}
