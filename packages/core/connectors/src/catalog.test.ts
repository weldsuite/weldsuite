import { describe, expect, it } from 'vitest';
import {
  CONNECTORS,
  connectorEntityTypes,
  getConnector,
  getConnectorEntity,
  listConnectors,
} from './catalog';
import { SYNCABLE_ENTITIES } from './entities';

describe('connector catalog', () => {
  it('has unique connector ids', () => {
    // The id is the driver registry key and the route param — a duplicate would
    // make which connector you get depend on array order.
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares only entity types the framework knows', () => {
    for (const connector of CONNECTORS) {
      for (const entity of connector.entities) {
        expect(SYNCABLE_ENTITIES).toContain(entity.entity);
      }
    }
  });

  it('namespaces every externalEntityType by connector', () => {
    // The mapping table is shared across connectors, so an unnamespaced
    // `contact` would collide the moment a second connector syncs contacts and
    // one provider's records would resolve to the other's internal rows.
    for (const connector of CONNECTORS) {
      for (const entity of connector.entities) {
        expect(entity.externalEntityType.startsWith(`${connector.id.replace(/-/g, '_')}_`)).toBe(
          true,
        );
      }
    }
  });

  it('has globally unique externalEntityType values', () => {
    const keys = CONNECTORS.flatMap((c) => c.entities.map((e) => e.externalEntityType));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares each entity at most once per connector', () => {
    for (const connector of CONNECTORS) {
      const entities = connector.entities.map((e) => e.entity);
      expect(new Set(entities).size).toBe(entities.length);
    }
  });

  it('sets a sane default sync interval', () => {
    // Below an hour is provider abuse; the scheduler clamps but the catalog
    // should not be asking for it in the first place.
    for (const connector of CONNECTORS) {
      expect(connector.defaultSyncIntervalHours).toBeGreaterThanOrEqual(1);
    }
  });

  it('resolves a connector and its entity definition', () => {
    expect(getConnector('moneybird')?.label).toBe('Moneybird');
    expect(getConnectorEntity('moneybird', 'customer')?.entityDef.externalEntityType).toBe(
      'moneybird_contact',
    );
  });

  it('returns undefined rather than throwing for unknown lookups', () => {
    expect(getConnector('nope')).toBeUndefined();
    expect(getConnectorEntity('nope', 'customer')).toBeUndefined();
    // Declared connector, undeclared entity.
    expect(getConnectorEntity('moneybird', 'opportunity')).toBeUndefined();
  });

  it('lists entity types for a manual sync', () => {
    expect(connectorEntityTypes('moneybird')).toEqual(['customer']);
    expect(connectorEntityTypes('nope')).toEqual([]);
  });

  it('exposes the same array through listConnectors', () => {
    expect(listConnectors()).toBe(CONNECTORS);
  });
});
