/**
 * Picks a provider's implementation. A provider folder exports a
 * `ProviderModule` (providers/<name>/index.ts); a part it has not filled yet is
 * absent, and asking for it is a `ProviderUnsupportedError` (422 for the member).
 */

import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { azureDevopsProvider } from './azure-devops';
import { bitbucketProvider } from './bitbucket';
import { githubProvider } from './github';
import { gitlabProvider } from './gitlab';
import {
  ProviderUnsupportedError,
  type ConnectionAdapter,
  type IssueSyncAdapter,
  type OAuthProvider,
  type ProviderModule,
  type ReviewAdapter,
} from './types';

const MODULES: Record<MergeProvider, ProviderModule> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
  azure_devops: azureDevopsProvider,
};

export function providerModule(provider: MergeProvider): ProviderModule {
  return MODULES[provider];
}

/** The provider's connection adapter; throws `ProviderUnsupportedError` when it has none yet. */
export function adapterFor(provider: MergeProvider): ConnectionAdapter {
  const adapter = MODULES[provider].connection;
  if (!adapter) throw new ProviderUnsupportedError(provider, 'connections');
  return adapter;
}

export function issueAdapterFor(provider: MergeProvider): IssueSyncAdapter {
  const adapter = MODULES[provider].issues;
  if (!adapter) throw new ProviderUnsupportedError(provider, 'issue sync');
  return adapter;
}

export function reviewAdapterFor(provider: MergeProvider): ReviewAdapter {
  const adapter = MODULES[provider].review;
  if (!adapter) throw new ProviderUnsupportedError(provider, 'review');
  return adapter;
}

export function oauthFor(provider: MergeProvider): OAuthProvider {
  const oauth = MODULES[provider].oauth;
  if (!oauth) throw new ProviderUnsupportedError(provider, 'OAuth');
  return oauth;
}
