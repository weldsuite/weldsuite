/**
 * Mobile EntitySyncMap for weldstash-app — prefixes lockstep with
 * `weldstashKeys` in lib/query-client.ts (same roots as platform WeldStash).
 */

import { inv, type EntitySyncMap } from '@weldsuite/realtime/react';
import { weldstashKeys } from './query-client';

/**
 * Topics the WMS mobile shell caches today, plus catalog twin aliases
 * (`wms_inventory` / `wms_product`) so either emitter refreshes the UI.
 */
export const weldstashSyncMap: EntitySyncMap = {
  // Runtime inventory routes publish `inventory`.
  inventory: inv(['weldstash', 'stock']),
  wms_inventory: inv(['weldstash', 'stock']),
  wms_adjustment: inv(['weldstash', 'stock']),
  // Product CRUD publishes commerce `product`; keep `wms_product` alias.
  product: inv(weldstashKeys.products(), ['weldstash', 'stock']),
  wms_product: inv(weldstashKeys.products(), ['weldstash', 'stock']),
  warehouse: inv(weldstashKeys.warehouses(), ['weldstash', 'stock']),
  picklist: inv(weldstashKeys.pickLists(), ['weldstash', 'stock']),
  // Supplier list is not cached on mobile yet; keep for future + parity.
  supplier: inv(['weldstash', 'suppliers']),
};
