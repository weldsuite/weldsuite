/**
 * The workspace-facing partner endpoints: managed billing, territory requests,
 * and whether the user belongs to a partner (for the link to the partner
 * portal). The portal itself is its own app (apps/web/partner).
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import type { PartnerWorkspaceRequestBody } from '@weldsuite/app-api-client/domains/partners';
import { useAppApi } from '@/lib/api/use-app-api';
import { partnerKeys } from '@/lib/partner/partner-keys';

/**
 * `GET /api/partner/me`: the user's partner memberships, empty for everyone who
 * is not a reseller. Only decides whether the sidebar shows the portal link.
 */
export function usePartnerMemberships() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { partners } = useAppApi();
  const query = useQuery({
    queryKey: partnerKeys.memberships(userId),
    queryFn: () => partners.me(),
    select: (res) => res.data,
    enabled: isLoaded && !!isSignedIn,
    // Ten minutes: this runs for every signed-in user just to decide whether
    // to show one menu entry.
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return { memberships: query.data ?? [] };
}

/**
 * `GET /api/billing/managed`: the licence of a partner-managed workspace, or
 * `null` for a workspace that is billed directly. Read by the settings pages,
 * the read-only / past-due banners and the App Store, so it is one shared query.
 * A failing request counts as "not managed" rather than blocking the page.
 */
export function useManagedBilling() {
  const { orgId } = useAuth();
  const { partners } = useAppApi();
  return useQuery({
    queryKey: partnerKeys.managedBilling(orgId),
    queryFn: () => partners.managedBilling(),
    select: (res) => res.data ?? null,
    enabled: Boolean(orgId),
    staleTime: 60 * 1000,
    retry: false,
  });
}

/** Territory signup: ask the partner for a workspace. Works without an active workspace. */
export function useSubmitPartnerRequest() {
  const { partners } = useAppApi();
  return useMutation({
    mutationFn: (body: PartnerWorkspaceRequestBody) => partners.submitWorkspaceRequest(body),
  });
}
