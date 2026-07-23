/**
 * App-API feature-flags domain client — flat `/api/feature-flags`.
 *
 * Read-only: resolves the client-exposed feature flags for the authenticated
 * user (evaluated server-side via Cloudflare Flagship).
 */

import type { ClientApi, DataResponse } from '../types';
import type { FeatureFlagsResponse } from '../schemas/feature-flags';

export function createFeatureFlagsApi(api: ClientApi) {
  return {
    get(): Promise<DataResponse<FeatureFlagsResponse>> {
      return api.get<DataResponse<FeatureFlagsResponse>>('/feature-flags');
    },
  };
}
