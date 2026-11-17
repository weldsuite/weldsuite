/**
 * @weldsuite/panel-react-native: WeldPanel analytics for React Native apps.
 *
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   import { createWeldPanel } from '@weldsuite/panel-react-native';
 *
 *   export const panel = createWeldPanel({ token: 'wpk_…', storage: AsyncStorage, app: { id: 'com.acme.shop', version: '2.1.0' } });
 *   panel.screen('Home');
 *   panel.track('Added to cart', { sku: 'A-100' });
 */

import { createClient, type WeldPanelMobile, type WeldPanelOptions } from './client';
import { LIB_VERSION } from './event';
import { nativePlatform } from './platform-native';

const noop = (): void => undefined;

/** What `createWeldPanel()` returns without a token: it does nothing. */
function inert(): WeldPanelMobile {
  return {
    version: LIB_VERSION,
    ready: Promise.resolve(),
    track: noop,
    screen: noop,
    identify: noop,
    reset: noop,
    people: { set: noop, set_once: noop, unset: noop, increment: noop },
    register: noop,
    registerOnce: noop,
    unregister: noop,
    group: noop,
    groups: { set: noop, set_once: noop, unset: noop },
    resetGroups: noop,
    consent: { grant: noop, revoke: noop },
    optOut: noop,
    optIn: noop,
    flush: () => Promise.resolve(),
    getDistinctId: () => null,
    getSessionId: () => null,
    shutdown: noop,
  };
}

/**
 * Start collecting for a project. Returns at once; the project's settings
 * and the stored state are loaded in the background (`ready`), and calls made
 * in the meantime are kept and run when they are.
 */
export function createWeldPanel(options: WeldPanelOptions): WeldPanelMobile {
  if (!options || typeof options.token !== 'string' || !options.token) {
    if (options && options.debug) console.warn('[weldpanel] no project token: collecting nothing');
    return inert();
  }
  return createClient({ ...options, platform: options.platform ?? nativePlatform() }).api;
}

export { DEFAULT_API_HOST } from './client';
export type { FetchLike, FetchResponse, WeldPanelMobile, WeldPanelOptions } from './client';
export type { DeviceInfo, DeviceType, PanelPlatform, Size } from './platform';
export type { StorageAdapter } from './storage';
export type { Properties, PropertyValue } from './wire';
