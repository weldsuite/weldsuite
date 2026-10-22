/**
 * App-API SSO domain client — `/api/sso`.
 *
 * Configuration (domain, Clerk SAML connection, on/off) is served by app-api;
 * the `/billing` paths are the SSO add-on subscription, which app-api forwards
 * to billing-worker. See `../schemas/sso.ts`.
 */

import type { ClientApi, DataResponse } from '../types';
import type { SsoBillingView, SsoConfigView, SsoConnectionInput } from '../schemas/sso';

export function createSsoApi(api: ClientApi) {
  return {
    get(): Promise<DataResponse<SsoConfigView>> {
      return api.get<DataResponse<SsoConfigView>>('/sso');
    },

    /** Claim a domain (resets its verification). 409 while a connection uses the current one. */
    setDomain(domain: string): Promise<DataResponse<SsoConfigView>> {
      return api.put<DataResponse<SsoConfigView>>('/sso/domain', { domain });
    },

    removeDomain(): Promise<DataResponse<SsoConfigView>> {
      return api.delete<DataResponse<SsoConfigView>>('/sso/domain');
    },

    /** Look up the TXT record. 422 `SSO_DOMAIN_NOT_VERIFIED` when it is not there (yet). */
    verifyDomain(): Promise<DataResponse<SsoConfigView>> {
      return api.post<DataResponse<SsoConfigView>>('/sso/domain/verify');
    },

    /** Create the connection, or update its provider and IdP details. */
    saveConnection(input: SsoConnectionInput): Promise<DataResponse<SsoConfigView>> {
      return api.put<DataResponse<SsoConfigView>>('/sso/connection', input);
    },

    removeConnection(): Promise<DataResponse<SsoConfigView>> {
      return api.delete<DataResponse<SsoConfigView>>('/sso/connection');
    },

    /** From now on, users with an email at the domain sign in through the IdP. */
    activate(): Promise<DataResponse<SsoConfigView>> {
      return api.post<DataResponse<SsoConfigView>>('/sso/connection/activate');
    },

    deactivate(): Promise<DataResponse<SsoConfigView>> {
      return api.post<DataResponse<SsoConfigView>>('/sso/connection/deactivate');
    },

    billing(): Promise<DataResponse<SsoBillingView>> {
      return api.get<DataResponse<SsoBillingView>>('/sso/billing');
    },

    /** Start the add-on on the card on file. */
    subscribe(): Promise<DataResponse<SsoBillingView>> {
      return api.post<DataResponse<SsoBillingView>>('/sso/billing/subscribe');
    },

    /** End the add-on at the end of the paid period. */
    cancel(): Promise<DataResponse<SsoBillingView>> {
      return api.post<DataResponse<SsoBillingView>>('/sso/billing/cancel');
    },

    /** Undo a cancellation that has not taken effect yet. */
    resume(): Promise<DataResponse<SsoBillingView>> {
      return api.post<DataResponse<SsoBillingView>>('/sso/billing/resume');
    },
  };
}

export type SsoApi = ReturnType<typeof createSsoApi>;
