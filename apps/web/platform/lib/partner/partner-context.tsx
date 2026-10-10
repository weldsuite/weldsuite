/**
 * Who the signed-in user is in the partner portal.
 *
 * `usePartnerMemberships` is also used outside the portal (the workspace menu
 * shows the entry only to partner members), so it lives apart from the
 * provider. The provider resolves the effective membership: the remembered
 * partner when the user still belongs to it, else the first one.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import {
  partnerRoleCan,
  type PartnerMemberRole,
  type PartnerMembership,
  type PartnerPermission,
} from '@weldsuite/app-api-client/schemas/partners';
import { partnerKeys, usePartnerClients, type PartnerClients } from './partner-api';
import {
  getSelectedPartnerId,
  setSelectedPartnerId,
  subscribeSelectedPartner,
} from './selected-partner';

const EMPTY: PartnerMembership[] = [];

/** The caller's partner memberships; empty for everyone who is not a reseller. */
export function usePartnerMemberships() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { account } = usePartnerClients(null);

  const query = useQuery({
    queryKey: partnerKeys.memberships(userId),
    queryFn: () => account.me(),
    select: (res) => res.data,
    enabled: isLoaded && !!isSignedIn,
    // Ten minutes: this runs for every signed-in user just to decide whether
    // to show one menu entry.
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  return {
    memberships: query.data ?? EMPTY,
    isLoading: !isLoaded || query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

export interface PartnerContextValue {
  memberships: PartnerMembership[];
  membership: PartnerMembership;
  partnerId: string;
  role: PartnerMemberRole;
  can: (permission: PartnerPermission) => boolean;
  select: (partnerId: string) => void;
  clients: PartnerClients;
}

const PartnerContext = createContext<PartnerContextValue | null>(null);

export function resolveMembership(
  memberships: readonly PartnerMembership[],
  selectedId: string | null,
): PartnerMembership | null {
  return memberships.find((m) => m.partnerId === selectedId) ?? memberships[0] ?? null;
}

/** Renders `children` only once there is a membership to act as. */
export function PartnerProvider({
  memberships,
  children,
}: Readonly<{ memberships: PartnerMembership[]; children: ReactNode }>) {
  const storedId = useSyncExternalStore(subscribeSelectedPartner, getSelectedPartnerId, () => null);
  const membership = resolveMembership(memberships, storedId);
  const partnerId = membership?.partnerId ?? null;
  const clients = usePartnerClients(partnerId);

  // Keep the stored choice pointing at something the user still belongs to.
  useEffect(() => {
    if (partnerId && storedId !== partnerId) setSelectedPartnerId(partnerId);
  }, [partnerId, storedId]);

  const select = useCallback((id: string) => setSelectedPartnerId(id), []);

  const value = useMemo<PartnerContextValue | null>(() => {
    if (!membership) return null;
    return {
      memberships,
      membership,
      partnerId: membership.partnerId,
      role: membership.role,
      can: (permission) => partnerRoleCan(membership.role, permission),
      select,
      clients,
    };
  }, [memberships, membership, select, clients]);

  if (!value) return null;
  return <PartnerContext.Provider value={value}>{children}</PartnerContext.Provider>;
}

export function usePartnerContext(): PartnerContextValue {
  const ctx = useContext(PartnerContext);
  if (!ctx) throw new Error('usePartnerContext must be used inside <PartnerProvider>');
  return ctx;
}
