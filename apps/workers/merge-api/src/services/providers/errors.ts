/**
 * Errors of the provider seam that are not the provider's own answer
 * (`ProviderApiError` in types.ts is that).
 */

import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';

/** The worker has no OAuth app credentials for the provider (a 503 for the caller). */
export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: MergeProvider) {
    super(`${provider} OAuth is not configured for WeldMerge`);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** The connection or account has no usable credentials (never linked, revoked, or the refresh failed). */
export class ProviderCredentialsError extends Error {
  constructor(
    readonly provider: MergeProvider,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderCredentialsError';
  }
}
