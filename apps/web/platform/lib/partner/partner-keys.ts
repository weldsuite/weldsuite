/**
 * TanStack Query keys for the partner queries the platform still makes. The
 * partner portal itself is its own app (apps/web/partner).
 */

export const partnerKeys = {
  all: ['partner'] as const,
  memberships: (userId: string | null | undefined) => [...partnerKeys.all, 'me', userId ?? 'anon'] as const,
  managedBilling: (orgId: string | null | undefined) => [...partnerKeys.all, 'managed-billing', orgId ?? 'none'] as const,
};
