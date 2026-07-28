import { describe, it, expect } from 'vitest';
import { CONNECTORS, connectorSyncNames, getConnector, getConnectorSync, listConnectors } from './catalog';

describe('connector catalog', () => {
  it('ships Salesforce and HubSpot as the first proven connectors', () => {
    expect(listConnectors().map((c) => c.providerConfigKey).sort()).toEqual(['hubspot', 'salesforce']);
  });

  it('keeps provider config keys unique — they are the Nango integration keys', () => {
    const keys = CONNECTORS.map((c) => c.providerConfigKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps external entity types unique per connector so mappings never collide', () => {
    for (const connector of CONNECTORS) {
      const types = connector.syncs.map((s) => s.externalEntityType);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it('resolves a sync from the (integration, model) pair a webhook carries', () => {
    const resolved = getConnectorSync('hubspot', 'HubspotContact');
    expect(resolved?.sync.internalEntity).toBe('person');
    expect(resolved?.sync.syncName).toBe('hubspot-contacts');
  });

  it('returns undefined for unknown integrations and models', () => {
    expect(getConnectorSync('pipedrive', 'PipedrivePerson')).toBeUndefined();
    expect(getConnectorSync('hubspot', 'HubspotTicket')).toBeUndefined();
    expect(getConnector('pipedrive')).toBeUndefined();
  });

  it('lists every sync name for a manual sync-now', () => {
    expect(connectorSyncNames('salesforce')).toEqual([
      'salesforce-accounts',
      'salesforce-contacts',
      'salesforce-opportunities',
    ]);
    expect(connectorSyncNames('unknown')).toEqual([]);
  });
});
