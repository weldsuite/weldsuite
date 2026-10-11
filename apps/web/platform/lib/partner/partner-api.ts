/**
 * API clients and query keys for the partner portal.
 *
 * The portal is not workspace-scoped: a partner user may have no active
 * workspace at all, and may belong to several partners. Portal calls therefore
 * carry `X-Partner-Id`; `GET /partner/me` and the workspace-facing endpoints do
 * not. Each client is built for one partner id so a request can never go out
 * with a stale selection.
 */

import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { createClientApi } from '@weldsuite/api-client/client';
import { createPartnersApi, type PartnersApi } from '@weldsuite/app-api-client/domains/partners';
import { getApiOriginForPath } from '@/lib/api/public-env';
export { partnerKeys } from './partner-keys';

export interface PartnerClients {
  /** Portal calls, with `X-Partner-Id`. */
  portal: PartnersApi;
  /** Same, plus extra headers (e.g. `Idempotency-Key`). */
  portalWith: (headers: Record<string, string>) => PartnersApi;
  /** Calls that must not carry a partner id (`/partner/me`). */
  account: PartnersApi;
}

export function usePartnerClients(partnerId: string | null): PartnerClients {
  const { getToken } = useAuth();

  return useMemo(() => {
    const make = (extra: Record<string, string>, withPartner: boolean) =>
      createPartnersApi(
        createClientApi({
          getToken: () => getToken(),
          baseUrl: getApiOriginForPath,
          getExtraHeaders: () => ({
            ...(withPartner && partnerId ? { 'X-Partner-Id': partnerId } : {}),
            ...extra,
          }),
        }),
      );
    return {
      portal: make({}, true),
      portalWith: (headers) => make(headers, true),
      account: make({}, false),
    };
  }, [getToken, partnerId]);
}
