/**
 * Starter EntitySyncMap for apps scaffolded from `_template`.
 * Add hub topics → query-key prefixes as screens land.
 *
 * @example
 * import { inv, type EntitySyncMap } from '@weldsuite/mobile-realtime';
 * export const appSyncMap: EntitySyncMap = {
 *   project: inv(['{{APP_CODE}}', 'projects']),
 * };
 */

import type { EntitySyncMap } from '@weldsuite/realtime/react';

/** Empty-by-default — RealtimeSyncBridge no-ops until topics are added. */
export const appSyncMap: EntitySyncMap = {};
