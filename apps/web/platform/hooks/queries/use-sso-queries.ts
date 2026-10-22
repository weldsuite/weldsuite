/**
 * Enterprise single sign-on (Settings > Single sign-on): the workspace's
 * configuration (domain, SAML connection, on/off) and the SSO add-on
 * subscription.
 *
 * The endpoints live in app-api (`/api/sso`); the `/billing` paths are
 * forwarded to billing-worker. Every write answers with the view after the
 * change, which goes straight into the cache. Buying, cancelling or resuming
 * the add-on changes what the workspace is entitled to, so those also refresh
 * the configuration.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { apiErrorCode } from '@/lib/partner/api-errors';
import type { DataResponse } from '@weldsuite/app-api-client/types';
import { SSO_ERRORS, type SsoBillingView, type SsoConfigView, type SsoConnectionInput } from '@weldsuite/app-api-client/schemas/sso';

export const ssoKeys = {
  all: ['sso'] as const,
  config: () => [...ssoKeys.all, 'config'] as const,
  billing: () => [...ssoKeys.all, 'billing'] as const,
};

/**
 * Failures that mean the page was showing a state that no longer holds (the
 * add-on ended in another tab, the connection was removed, a payment lapsed):
 * refetch both views so the page corrects itself.
 */
const STALE_STATE_CODES: ReadonlySet<string> = new Set([
  SSO_ERRORS.NOT_ENTITLED,
  SSO_ERRORS.ADDON_UNAVAILABLE,
  SSO_ERRORS.ALREADY_SUBSCRIBED,
  SSO_ERRORS.NOT_SUBSCRIBED,
  SSO_ERRORS.CONNECTION_MISSING,
  SSO_ERRORS.DOMAIN_MISSING,
  SSO_ERRORS.DOMAIN_LOCKED,
]);

function refreshWhenStale(qc: QueryClient, err: unknown): void {
  const code = apiErrorCode(err);
  if (code && STALE_STATE_CODES.has(code)) {
    void qc.invalidateQueries({ queryKey: ssoKeys.all });
  }
}

/** The workspace's SSO configuration: entitlement, domain, connection. */
export function useSsoConfig(enabled = true) {
  const { sso } = useAppApi();
  return useQuery({
    queryKey: ssoKeys.config(),
    queryFn: () => sso.get(),
    select: (res) => res.data,
    enabled,
  });
}

/** The add-on priced for this workspace, and whether it can be bought. */
export function useSsoBilling(enabled = true) {
  const { sso } = useAppApi();
  return useQuery({
    queryKey: ssoKeys.billing(),
    queryFn: () => sso.billing(),
    select: (res) => res.data,
    enabled,
  });
}

// ============================================================================
// Configuration (sso:manage)
// ============================================================================

/** Shared by every configuration write: the answer is the configuration after it. */
function useConfigMutation<TVariables>(run: (variables: TVariables) => Promise<DataResponse<SsoConfigView>>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (res) => {
      qc.setQueryData(ssoKeys.config(), res);
    },
    onError: (err) => refreshWhenStale(qc, err),
  });
}

/** Claim a domain (resets its verification). 409 while a connection uses the current one. */
export function useSetSsoDomain() {
  const { sso } = useAppApi();
  return useConfigMutation((domain: string) => sso.setDomain(domain));
}

export function useRemoveSsoDomain() {
  const { sso } = useAppApi();
  return useConfigMutation<void>(() => sso.removeDomain());
}

/** Look up the TXT record. 422 `SSO_DOMAIN_NOT_VERIFIED` while it is not there. */
export function useVerifySsoDomain() {
  const { sso } = useAppApi();
  return useConfigMutation<void>(() => sso.verifyDomain());
}

/** Create the connection, or update its provider and IdP details. */
export function useSaveSsoConnection() {
  const { sso } = useAppApi();
  return useConfigMutation((input: SsoConnectionInput) => sso.saveConnection(input));
}

export function useRemoveSsoConnection() {
  const { sso } = useAppApi();
  return useConfigMutation<void>(() => sso.removeConnection());
}

/** From now on, users with an email at the domain sign in through the IdP. */
export function useActivateSso() {
  const { sso } = useAppApi();
  return useConfigMutation<void>(() => sso.activate());
}

export function useDeactivateSso() {
  const { sso } = useAppApi();
  return useConfigMutation<void>(() => sso.deactivate());
}

// ============================================================================
// Add-on subscription (billing:manage)
// ============================================================================

/** Shared by the add-on writes: the answer is the add-on after it; entitlement may have changed. */
function useBillingMutation(run: () => Promise<DataResponse<SsoBillingView>>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (res) => {
      qc.setQueryData(ssoKeys.billing(), res);
      void qc.invalidateQueries({ queryKey: ssoKeys.config() });
    },
    onError: (err) => refreshWhenStale(qc, err),
  });
}

/** Start the add-on on the card on file. */
export function useSubscribeSso() {
  const { sso } = useAppApi();
  return useBillingMutation(() => sso.subscribe());
}

/** End the add-on at the end of the paid period. */
export function useCancelSso() {
  const { sso } = useAppApi();
  return useBillingMutation(() => sso.cancel());
}

/** Undo a cancellation that has not taken effect yet. */
export function useResumeSso() {
  const { sso } = useAppApi();
  return useBillingMutation(() => sso.resume());
}
