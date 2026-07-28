/**
 * Guards on the aggregated entity-event catalog.
 *
 * `ENTITY_EVENTS` is the single source of truth for `publishEntityEvent`'s
 * action narrowing, agent `eventSubscriptions`, and workflow `entity_event`
 * triggers. A duplicate key across two module catalogs silently loses one of
 * them to the spread in `index.ts`, and there is no type error to catch it.
 */

import { describe, it, expect } from 'vitest';
import { ENTITY_EVENTS } from './index';
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

const MODULE_CATALOGS: Array<[string, Record<string, readonly string[]>]> = [
  ['crm', CRM_ENTITY_EVENTS],
  ['projects', PROJECTS_ENTITY_EVENTS],
  ['helpdesk', HELPDESK_ENTITY_EVENTS],
  ['mail', MAIL_ENTITY_EVENTS],
  ['commerce', COMMERCE_ENTITY_EVENTS],
  ['accounting', ACCOUNTING_ENTITY_EVENTS],
  ['wms', WMS_ENTITY_EVENTS],
  ['chat', CHAT_ENTITY_EVENTS],
  ['meetings', MEETINGS_ENTITY_EVENTS],
  ['workspace', WORKSPACE_ENTITY_EVENTS],
  ['social', SOCIAL_ENTITY_EVENTS],
  ['parcels', PARCELS_ENTITY_EVENTS],
  ['host', HOST_ENTITY_EVENTS],
  ['drive', DRIVE_ENTITY_EVENTS],
  ['welddata', WELDDATA_ENTITY_EVENTS],
  ['knowledge', KNOWLEDGE_ENTITY_EVENTS],
  ['user-apps', USER_APPS_ENTITY_EVENTS],
];

describe('ENTITY_EVENTS catalog', () => {
  /**
   * Exactly one module may own an entity type.
   *
   * `index.ts` builds the catalog by spreading the module catalogs in order, so
   * a key declared twice is silently resolved by position. That is how
   * `meeting_bot_session` used to work: `crm` declared three actions and
   * `meetings` five, and only the spread order kept `started`/`completed`
   * reachable — reorder the imports and every workflow trigger bound to them
   * would go quiet with no error anywhere.
   */
  it('has no entity type claimed by two modules', () => {
    const owners = new Map<string, string[]>();
    for (const [module, catalog] of MODULE_CATALOGS) {
      for (const entityType of Object.keys(catalog)) {
        owners.set(entityType, [...(owners.get(entityType) ?? []), module]);
      }
    }
    const duplicates = [...owners.entries()].filter(([, modules]) => modules.length > 1);
    expect(duplicates).toEqual([]);
  });

  it('keeps the full action set for entity types that were previously duplicated', () => {
    // Regression guard for the dedupe: these are the three keys that used to be
    // declared twice, with the surviving owner in the comment.
    expect(ENTITY_EVENTS.meeting_bot_session).toEqual([
      'created',
      'updated',
      'deleted',
      'started',
      'completed',
    ]); // meetings
    expect(ENTITY_EVENTS.analytics_report).toEqual(['created', 'updated', 'deleted']); // projects
    expect(ENTITY_EVENTS.notification_template).toEqual(['created', 'updated', 'deleted']); // workspace
  });

  it('aggregates every module catalog without dropping entries', () => {
    const expected = MODULE_CATALOGS.reduce((n, [, catalog]) => n + Object.keys(catalog).length, 0);
    expect(Object.keys(ENTITY_EVENTS)).toHaveLength(expected);
  });

  it('gives every entity type at least one action', () => {
    // Widened deliberately: the literal action-tuple types make TS treat
    // `.length === 0` as provably false, which is exactly what this asserts at
    // runtime for a catalog someone could still edit down to `[]`.
    const entries = Object.entries(ENTITY_EVENTS) as Array<[string, readonly string[]]>;
    expect(entries.filter(([, actions]) => actions.length === 0)).toEqual([]);
  });

  it('has no duplicate action within an entity type', () => {
    for (const [entityType, actions] of Object.entries(ENTITY_EVENTS)) {
      expect(new Set(actions).size, `${entityType} repeats an action`).toBe(actions.length);
    }
  });
});

describe('connector_connection', () => {
  it('is registered so the connector routes can publish', () => {
    expect(ENTITY_EVENTS).toHaveProperty('connector_connection');
  });

  it('covers the lifecycle transitions the connector routes emit', () => {
    // Each of these is published from apps/workers/app-api — routes/nango/index.ts
    // (created, connected, sync_started, paused, resumed, disconnected,
    // auth_error) and routes/public-nango-webhook.ts (connected, auth_error).
    for (const action of [
      'created',
      'connected',
      'disconnected',
      'paused',
      'resumed',
      'sync_started',
      'auth_error',
    ]) {
      expect(ENTITY_EVENTS.connector_connection).toContain(action);
    }
  });

  it('is named for the capability, not the vendor', () => {
    // The connector provider is a config choice (see the ADR); baking "nango"
    // into the catalog would make swapping it break every workflow trigger and
    // agent subscription bound to the event name.
    expect(Object.keys(ENTITY_EVENTS).filter((k) => k.includes('nango'))).toEqual([]);
  });
});
