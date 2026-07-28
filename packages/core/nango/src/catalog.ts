/**
 * WeldSuite connector catalog — the connectors we have actually wired to
 * WeldSuite data models, not the full Nango provider list.
 *
 * Nango supports 500+ APIs; browsing all of them in the UI would promise
 * imports we cannot perform. A connector only appears here once its syncs have
 * a mapper into a WeldSuite entity, so "visible in the catalog" and "safe to
 * connect" mean the same thing.
 *
 * Adding a connector: add an entry here, add a mapper for each
 * `internalEntity` it declares, and create the matching integration in Nango
 * with `providerConfigKey` as its unique key.
 */

/** WeldSuite entity a synced model lands in. */
export type ConnectorEntity = 'company' | 'person' | 'opportunity';

export type ConnectorCategory = 'crm' | 'accounting' | 'support' | 'productivity';

export interface ConnectorSyncDef {
  /** Sync name as configured in Nango. */
  syncName: string;
  /** Nango model the sync emits — the `model` field on record + webhook payloads. */
  model: string;
  /** WeldSuite entity the records are mapped into. */
  internalEntity: ConnectorEntity;
  /** Mapping key stored on `integration_entity_mappings.externalEntityType`. */
  externalEntityType: string;
}

export interface ConnectorDef {
  /** Stable WeldSuite id, also the Nango integration unique key. */
  providerConfigKey: string;
  /** Underlying Nango provider slug. */
  provider: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Icon key resolved to a lucide component by the platform UI. */
  icon: string;
  /** OAuth scopes requested — surfaced in the UI before the user authorises. */
  scopes: string[];
  syncs: ConnectorSyncDef[];
}

export const CONNECTORS: ConnectorDef[] = [
  {
    providerConfigKey: 'salesforce',
    provider: 'salesforce',
    label: 'Salesforce',
    description: 'Sync Salesforce accounts, contacts and opportunities into WeldCRM.',
    category: 'crm',
    icon: 'cloud',
    scopes: ['api', 'refresh_token', 'offline_access'],
    syncs: [
      {
        syncName: 'salesforce-accounts',
        model: 'SalesforceAccount',
        internalEntity: 'company',
        externalEntityType: 'salesforce_account',
      },
      {
        syncName: 'salesforce-contacts',
        model: 'SalesforceContact',
        internalEntity: 'person',
        externalEntityType: 'salesforce_contact',
      },
      {
        syncName: 'salesforce-opportunities',
        model: 'SalesforceOpportunity',
        internalEntity: 'opportunity',
        externalEntityType: 'salesforce_opportunity',
      },
    ],
  },
  {
    providerConfigKey: 'hubspot',
    provider: 'hubspot',
    label: 'HubSpot',
    description: 'Sync HubSpot companies, contacts and deals into WeldCRM.',
    category: 'crm',
    icon: 'database',
    scopes: ['crm.objects.companies.read', 'crm.objects.contacts.read', 'crm.objects.deals.read'],
    syncs: [
      {
        syncName: 'hubspot-companies',
        model: 'HubspotCompany',
        internalEntity: 'company',
        externalEntityType: 'hubspot_company',
      },
      {
        syncName: 'hubspot-contacts',
        model: 'HubspotContact',
        internalEntity: 'person',
        externalEntityType: 'hubspot_contact',
      },
      {
        syncName: 'hubspot-deals',
        model: 'HubspotDeal',
        internalEntity: 'opportunity',
        externalEntityType: 'hubspot_deal',
      },
    ],
  },
];

export function listConnectors(): ConnectorDef[] {
  return CONNECTORS;
}

export function getConnector(providerConfigKey: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.providerConfigKey === providerConfigKey);
}

/** Resolve a sync definition from the `(integration, model)` pair a webhook carries. */
export function getConnectorSync(
  providerConfigKey: string,
  model: string,
): { connector: ConnectorDef; sync: ConnectorSyncDef } | undefined {
  const connector = getConnector(providerConfigKey);
  if (!connector) return undefined;
  const sync = connector.syncs.find((s) => s.model === model);
  if (!sync) return undefined;
  return { connector, sync };
}

/** All sync names for a connector — the payload for a manual "sync now". */
export function connectorSyncNames(providerConfigKey: string): string[] {
  return getConnector(providerConfigKey)?.syncs.map((s) => s.syncName) ?? [];
}
