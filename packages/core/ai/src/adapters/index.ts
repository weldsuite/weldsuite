/**
 * Adapter registry — builds the Cloudflare adapter for a resolved config.
 *
 * Static import keeps `createWeldAI()` **synchronous**: every call site (and
 * `workflow-worker`'s test mock) depends on that signature.
 */

import { createCloudflareAdapter } from './cloudflare.js';
import type { AdapterRuntime } from './types.js';

import type { WeldAiConfig } from '../config.js';

/** Build the adapter runtime for an already-resolved config. */
export function createAdapter(config: WeldAiConfig): AdapterRuntime {
  return createCloudflareAdapter(config);
}

export { createCloudflareAdapter };
export {
  UnsupportedModelError,
  GatewayConfigError,
  type AdapterFactory,
  type AdapterRuntime,
  type GatewayProvider,
} from './types.js';
