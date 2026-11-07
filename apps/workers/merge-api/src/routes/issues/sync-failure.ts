/**
 * Provider failures of the explicit issue-sync routes as responses: the
 * provider refusing is 502 `provider_error` (its own message), a provider
 * without issue sync 422, a worker without the GitHub App's credentials 503.
 * Anything else is not ours to answer.
 */

import { GithubNotConfiguredError } from '../../services/github-client';
import { ProviderApiError, ProviderUnsupportedError } from '../../services/providers/types';
import type { Ctx } from '../shared';

export function syncFailure(c: Ctx, err: unknown): Response | null {
  if (err instanceof ProviderApiError) return c.json({ error: { code: 'provider_error', message: err.message } }, 502);
  if (err instanceof ProviderUnsupportedError) return c.json({ error: { code: 'UNPROCESSABLE_ENTITY', message: err.message } }, 422);
  if (err instanceof GithubNotConfiguredError) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'GitHub is not configured for WeldMerge' } }, 503);
  }
  return null;
}
