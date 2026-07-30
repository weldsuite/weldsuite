/**
 * Driver registry.
 *
 * Drivers register at module load; the sync loop, the webhook route and the
 * connect flow all resolve through here by connector id. Registration is
 * explicit rather than filesystem-scanned because Workers bundle statically —
 * a dynamically-discovered driver would simply not be in the bundle.
 */

import type { ConnectorDriver } from './types';

const drivers = new Map<string, ConnectorDriver>();

/**
 * Register a driver. Registering the same id twice is a programming error —
 * silently keeping one of the two would make behaviour depend on import order.
 */
export function registerDriver(driver: ConnectorDriver): void {
  if (drivers.has(driver.connectorId)) {
    throw new Error(`Connector driver already registered: ${driver.connectorId}`);
  }
  drivers.set(driver.connectorId, driver);
}

/** Resolve a driver, or undefined when nothing is registered for the id. */
export function findDriver(connectorId: string): ConnectorDriver | undefined {
  return drivers.get(connectorId);
}

/**
 * Resolve a driver or throw.
 *
 * Use this on paths where a missing driver means the request was malformed
 * (a webhook for an unknown connector, a sync for one we no longer ship).
 */
export function getDriver(connectorId: string): ConnectorDriver {
  const driver = drivers.get(connectorId);
  if (!driver) throw new Error(`No connector driver registered for: ${connectorId}`);
  return driver;
}

export function hasDriver(connectorId: string): boolean {
  return drivers.has(connectorId);
}

export function registeredDriverIds(): string[] {
  return [...drivers.keys()];
}

/** Test-only: drop every registration so suites do not leak into each other. */
export function resetDrivers(): void {
  drivers.clear();
}
