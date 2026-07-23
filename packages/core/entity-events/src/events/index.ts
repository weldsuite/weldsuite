/**
 * Aggregated entity-event catalog.
 *
 * Every WeldSuite entity that emits an entity event registers its
 * subscribable actions here. The aggregated `ENTITY_EVENTS` object is the
 * single source of truth — `publishEntityEvent` narrows its action
 * parameter against it, agent `eventSubscriptions` validate against it,
 * and workflow `entity_event` triggers match against it.
 *
 * Action sets include both physical actions (what publishers emit on the
 * wire — created/updated/deleted/archived plus a handful of custom
 * physical actions) and derived subscription actions (won/lost/paid/
 * resolved/escalated — computed inside agent-dispatch from base actions
 * + change-detection).
 */

import { CRM_ENTITY_EVENTS } from './crm';
import { PROJECTS_ENTITY_EVENTS } from './projects';
import { HELPDESK_ENTITY_EVENTS } from './helpdesk';
import { MAIL_ENTITY_EVENTS } from './mail';
import { COMMERCE_ENTITY_EVENTS } from './commerce';
import { ACCOUNTING_ENTITY_EVENTS } from './accounting';
import { WMS_ENTITY_EVENTS } from './wms';
import { CHAT_ENTITY_EVENTS } from './chat';
import { MEETINGS_ENTITY_EVENTS } from './meetings';
import { WORKSPACE_ENTITY_EVENTS } from './workspace';
import { SOCIAL_ENTITY_EVENTS } from './social';
import { PARCELS_ENTITY_EVENTS } from './parcels';
import { HOST_ENTITY_EVENTS } from './host';
import { DRIVE_ENTITY_EVENTS } from './drive';
import { WELDDATA_ENTITY_EVENTS } from './welddata';
import { KNOWLEDGE_ENTITY_EVENTS } from './knowledge';
import { USER_APPS_ENTITY_EVENTS } from './user-apps';

export const ENTITY_EVENTS = {
  ...CRM_ENTITY_EVENTS,
  ...PROJECTS_ENTITY_EVENTS,
  ...HELPDESK_ENTITY_EVENTS,
  ...MAIL_ENTITY_EVENTS,
  ...COMMERCE_ENTITY_EVENTS,
  ...ACCOUNTING_ENTITY_EVENTS,
  ...WMS_ENTITY_EVENTS,
  ...CHAT_ENTITY_EVENTS,
  ...MEETINGS_ENTITY_EVENTS,
  ...WORKSPACE_ENTITY_EVENTS,
  ...SOCIAL_ENTITY_EVENTS,
  ...PARCELS_ENTITY_EVENTS,
  ...HOST_ENTITY_EVENTS,
  ...DRIVE_ENTITY_EVENTS,
  ...WELDDATA_ENTITY_EVENTS,
  ...KNOWLEDGE_ENTITY_EVENTS,
  ...USER_APPS_ENTITY_EVENTS,
} as const;

export type EntityType = keyof typeof ENTITY_EVENTS;

export type ActionFor<T extends EntityType> = (typeof ENTITY_EVENTS)[T][number];

/** Colon-separated wire format: "customer:created", "opportunity:won". */
export type EventName = {
  [E in EntityType]: `${E & string}:${ActionFor<E> & string}`;
}[EntityType];

/** Dotted format — used by agent `eventSubscriptions` + workflow triggers. */
export type EventNameDotted = {
  [E in EntityType]: `${E & string}.${ActionFor<E> & string}`;
}[EntityType];

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

const KNOWN_ENTITY_TYPES = new Set<string>(Object.keys(ENTITY_EVENTS));

export function isKnownEntityType(value: string): value is EntityType {
  return KNOWN_ENTITY_TYPES.has(value);
}

export function isKnownAction<T extends EntityType>(
  entityType: T,
  action: string,
): action is ActionFor<T> {
  const actions = ENTITY_EVENTS[entityType] as readonly string[];
  return actions.includes(action);
}

/** Return every catalog event in dotted form. */
export function listAllEvents(): readonly EventNameDotted[] {
  const out: string[] = [];
  for (const [entityType, actions] of Object.entries(ENTITY_EVENTS)) {
    for (const action of actions) {
      out.push(`${entityType}.${action}`);
    }
  }
  return out as readonly EventNameDotted[];
}

/** Return every catalog event in colon-separated wire form. */
export function listAllWireEvents(): readonly EventName[] {
  const out: string[] = [];
  for (const [entityType, actions] of Object.entries(ENTITY_EVENTS)) {
    for (const action of actions) {
      out.push(`${entityType}:${action}`);
    }
  }
  return out as readonly EventName[];
}

/**
 * Parse a dotted or colon-separated event name into its parts. Returns
 * `null` when the entity portion is not in the catalog.
 */
export function parseEventName(
  name: string,
): { entityType: EntityType; action: string } | null {
  const sep = name.includes(':') ? ':' : name.includes('.') ? '.' : null;
  if (!sep) return null;
  const idx = name.indexOf(sep);
  const entityType = name.slice(0, idx);
  const action = name.slice(idx + 1);
  if (!isKnownEntityType(entityType)) return null;
  return { entityType, action };
}

/**
 * Validate a dotted subscription string against the catalog.
 * Used to validate `agent.eventSubscriptions` entries on insert/update.
 */
export function isValidSubscription(value: string): value is EventNameDotted {
  const parsed = parseEventName(value);
  if (!parsed) return false;
  return isKnownAction(parsed.entityType, parsed.action);
}

// ---------------------------------------------------------------------------
// Payload-shape map (type-only)
// ---------------------------------------------------------------------------

export type { EntityEventData, DataFor } from './data';
