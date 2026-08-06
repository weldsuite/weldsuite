/**
 * Subscription matching.
 *
 * Subscriptions are written in either wire form (`customer:created`) or dotted
 * form (`customer.created`) — the catalog helpers accept both, so these do too.
 * Everything is normalised to wire form once, at registration, and matched as
 * plain strings afterwards.
 */

import { CUSTOM_OBJECT_ENTITY_KEY_PREFIX } from '../custom-objects';
import type { ConsumerSubscription } from './types';

/** Matches every event, in any position. */
export const WILDCARD = '*';

/** `co_*` — any WeldObjects custom object, any action. */
export const CUSTOM_OBJECT_WILDCARD = `${CUSTOM_OBJECT_ENTITY_KEY_PREFIX}${WILDCARD}`;

/**
 * Split `entityType:action` / `entityType.action` on the first separator.
 * Entity types never contain `:` or `.`; actions never contain `:`.
 */
export function splitEventName(name: string): { entityType: string; action: string } | null {
  const colon = name.indexOf(':');
  const dot = name.indexOf('.');
  const idx = colon !== -1 ? colon : dot;
  if (idx <= 0 || idx === name.length - 1) return null;
  return { entityType: name.slice(0, idx), action: name.slice(idx + 1) };
}

/** Rewrite a subscription into canonical `entityType:action` wire form. */
export function normalizeSubscription(subscription: string): string {
  if (subscription === WILDCARD) return WILDCARD;
  if (subscription === CUSTOM_OBJECT_WILDCARD) return CUSTOM_OBJECT_WILDCARD;
  const parts = splitEventName(subscription);
  return parts ? `${parts.entityType}:${parts.action}` : subscription;
}

/**
 * Does `eventType` (always wire form, straight off the message) satisfy one
 * normalised subscription?
 */
export function matchesOne(eventType: string, subscription: string): boolean {
  if (subscription === WILDCARD) return true;

  const event = splitEventName(eventType);
  if (!event) return false;

  if (subscription === CUSTOM_OBJECT_WILDCARD) {
    return event.entityType.startsWith(CUSTOM_OBJECT_ENTITY_KEY_PREFIX);
  }

  const sub = splitEventName(subscription);
  if (!sub) return false;
  // `*:deleted` — one action across every entity type.
  if (sub.entityType !== WILDCARD && sub.entityType !== event.entityType) return false;
  return sub.action === WILDCARD || sub.action === event.action;
}

/** Does `eventType` satisfy any of a consumer's subscriptions? */
export function matches(
  eventType: string,
  subscribes: readonly ConsumerSubscription[] | typeof WILDCARD,
): boolean {
  if (subscribes === WILDCARD) return true;
  return subscribes.some((s) => matchesOne(eventType, s));
}
