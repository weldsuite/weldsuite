/**
 * WeldSuite connector catalog — the connectors wired to WeldSuite data models.
 *
 * A connector appears here only once it has a registered driver and a mapper for
 * every entity it declares, so "visible in the catalog" and "safe to connect"
 * mean the same thing. Listing a provider we cannot actually import from would
 * promise a sync that silently does nothing.
 *
 * The catalog holds **presentation and declaration**: label, category, scopes,
 * which entities land where. Behaviour lives on the driver. Auth modes are
 * deliberately *not* duplicated here — the routes read them off
 * `getDriver(id).authModes` so there is one source of truth for what a connector
 * can actually do.
 *
 * Adding a connector: an entry here, a driver registered under the same `id`,
 * and a mapper for each declared `entity`.
 */

import type { ConnectorCategory, SyncEntityType } from './entities';

export interface ConnectorEntityDef {
  /** WeldSuite entity the records land in. */
  entity: SyncEntityType;
  /**
   * Mapping key stored on `integration_entity_mappings.external_entity_type`.
   *
   * Namespaced by connector (`moneybird_contact`) because the mapping table is
   * shared across every connector — an unnamespaced `contact` would collide the
   * moment a second connector synced contacts.
   */
  externalEntityType: string;
}

export interface ConnectorDef {
  /** Stable id. Also the driver registry key and the catalog route param. */
  id: string;
  label: string;
  /** One line, shown on the connector card. Translated in the UI, not here. */
  description: string;
  category: ConnectorCategory;
  /** Icon key the platform resolves to a lucide component. */
  icon: string;
  /** OAuth scopes requested — surfaced before the tenant authorises. */
  scopes: string[];
  entities: ConnectorEntityDef[];
  /** How often the scheduler sweeps this connector when the tenant has not chosen. */
  defaultSyncIntervalHours: number;
}

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'moneybird',
    label: 'Moneybird',
    description: 'Sync Moneybird contacts into WeldSuite.',
    category: 'accounting',
    icon: 'receipt',
    // Read-only: nothing in the inbound sync writes back, and asking for write
    // scopes we do not use is a scope the tenant has to justify to their
    // accountant for no benefit.
    scopes: ['sales_invoices', 'documents', 'settings'],
    entities: [
      { entity: 'customer', externalEntityType: 'moneybird_contact' },
      // Sales invoices are deliberately absent. The driver can already fetch
      // them, but `invoices` has a NOT NULL `entity_id` (the accounting entity)
      // with no derivable default when a workspace has more than one, and
      // writing rows into the ledger affects VAT and P&L. Enabling this needs
      // two decisions first — which accounting entity an imported invoice
      // belongs to, and whether it posts a journal entry — then it is an entry
      // here plus a mapper.
    ],
    defaultSyncIntervalHours: 6,
  },
];

export function listConnectors(): ConnectorDef[] {
  return CONNECTORS;
}

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/** Resolve the entity definition for a `(connector, entity)` pair. */
export function getConnectorEntity(
  connectorId: string,
  entity: SyncEntityType,
): { connector: ConnectorDef; entityDef: ConnectorEntityDef } | undefined {
  const connector = getConnector(connectorId);
  if (!connector) return undefined;
  const entityDef = connector.entities.find((e) => e.entity === entity);
  if (!entityDef) return undefined;
  return { connector, entityDef };
}

/** Every entity type a connector declares — the payload for a manual "sync now". */
export function connectorEntityTypes(connectorId: string): SyncEntityType[] {
  return getConnector(connectorId)?.entities.map((e) => e.entity) ?? [];
}
