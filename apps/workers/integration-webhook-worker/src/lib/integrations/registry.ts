import type { IntegrationProvider } from './types';
import { AttioProvider } from './providers/attio/index';
import { HubSpotProvider } from './providers/hubspot/index';

const providers: Record<string, IntegrationProvider> = {
  attio: new AttioProvider(),
  hubspot: new HubSpotProvider(),
};

/**
 * Get an integration provider by name.
 */
export function getProvider(name: string): IntegrationProvider | undefined {
  return providers[name];
}
