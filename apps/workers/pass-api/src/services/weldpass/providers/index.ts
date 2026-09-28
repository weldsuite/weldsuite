/**
 * Deploy-target registry. Routes come here rather than importing a specific
 * provider, so adding one (Netlify, Fly, GitHub Actions) is a single entry.
 */

import type { WeldPassProvider, WeldPassSyncTargetConfig } from '@weldsuite/db/schema/weldpass';
import { cloudflarePagesProvider, cloudflareWorkersProvider, cloudflareRedeployNotice } from './cloudflare';
import { VERCEL_REDEPLOY_NOTICE, vercelProvider } from './vercel';
import { ProviderError, type SyncProvider } from './types';

const PROVIDERS: Record<WeldPassProvider, SyncProvider> = {
  cloudflare_workers: cloudflareWorkersProvider,
  cloudflare_pages: cloudflarePagesProvider,
  vercel: vercelProvider,
};

export function getProvider(id: WeldPassProvider): SyncProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new ProviderError(`Unknown deploy target provider: ${id}`);
  return provider;
}

export function listProviders(): Array<{ id: WeldPassProvider; label: string }> {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label }));
}

/** What still has to happen on the target before the new values take effect. */
export function redeployNotice(config: WeldPassSyncTargetConfig): string | null {
  if (config.provider === 'vercel') return VERCEL_REDEPLOY_NOTICE;
  return cloudflareRedeployNotice(config);
}

export * from './types';
