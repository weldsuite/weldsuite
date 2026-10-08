/**
 * Tax zone matching for the manual engine: a zone lists five-digit ZIPs and
 * inclusive ZIP ranges, or marks the seller's own location (`isOrigin`).
 */

import type { ManualZone } from './types';

function zip5(value: string): string | undefined {
  const match = /^(\d{5})/.exec(value.trim());
  return match ? match[1] : undefined;
}

/** True when the zone's ZIP list covers the ZIP (ZIP+4 entries count as their ZIP). */
export function zoneCoversZip(zone: ManualZone, zip: string | undefined): boolean {
  if (!zip) return false;
  for (const entry of zone.postalCodes) {
    if (typeof entry === 'string') {
      if (zip5(entry) === zip) return true;
      continue;
    }
    const from = zip5(entry.from);
    const to = zip5(entry.to);
    if (from && to && zip >= from && zip <= to) return true;
  }
  return false;
}

function byPriority(a: ManualZone, b: ManualZone): number {
  return a.priority - b.priority;
}

/** The destination zone of an agency: the lowest-priority zone that covers the ZIP. */
export function pickDestinationZone(zones: ManualZone[], zip: string | undefined): ManualZone | undefined {
  return zones.filter((z) => zoneCoversZip(z, zip)).sort(byPriority)[0];
}

/**
 * The origin zone of an agency: the seller-location zone that covers the
 * ship-from ZIP (a business with several locations has one per location), else
 * the first seller-location zone, else any zone that covers the ship-from ZIP.
 */
export function pickOriginZone(zones: ManualZone[], shipFromZip: string | undefined): ManualZone | undefined {
  const origins = zones.filter((z) => z.isOrigin).sort(byPriority);
  return (
    origins.find((z) => zoneCoversZip(z, shipFromZip)) ??
    origins[0] ??
    zones.filter((z) => zoneCoversZip(z, shipFromZip)).sort(byPriority)[0]
  );
}
