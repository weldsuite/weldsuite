
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  BillingPaymentMethodResponse,
  BillingSubscriptionResponse,
  PhoneSubscriptionResponse,
} from '@/lib/api/domains/billing';
import type { Billing } from '@/lib/api/types/apps/billing.types';

// =============================================================================
// Query Keys
// =============================================================================

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  invoices: (limit?: number) => [...billingKeys.all, 'invoices', limit] as const,
  payments: (filters?: Record<string, unknown>) => [...billingKeys.all, 'payments', filters] as const,
  limits: () => [...billingKeys.all, 'limits'] as const,
  phoneSubscription: () => [...billingKeys.all, 'phone-subscription'] as const,
  paymentMethods: () => [...billingKeys.all, 'payment-methods'] as const,
};

const creditsKeys = {
  all: ['credits'] as const,
  balance: () => [...creditsKeys.all, 'balance'] as const,
  transactions: (filters?: Record<string, unknown>) => [...creditsKeys.all, 'transactions', filters] as const,
  availability: (amount: number) => [...creditsKeys.all, 'availability', amount] as const,
  packages: () => [...creditsKeys.all, 'packages'] as const,
  rates: () => [...creditsKeys.all, 'rates'] as const,
  usage: () => [...creditsKeys.all, 'usage'] as const,
  subscription: () => [...creditsKeys.all, 'subscription'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Billing Queries
// =============================================================================

export function useSubscription() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.subscription(),
    queryFn: async () => {
      const client = await getClient();
      // Unwrapped: the legacy worker returned the subscription at the top level, and
      // consumers (weldcall-gate) read `subscription.planSlug` directly. app-api wraps
      // it in `{ data }`, so unwrap here to keep the hook's value identical.
      const res = await client.get<{ data: BillingSubscriptionResponse }>('/billing/subscription');
      return res.data;
    },
  });
}

/**
 * Plans catalog + the caller's subscription, from the same payload the
 * "Plans" settings page (`BillingSettingsSection`) loads directly via
 * `useAppApiClient()`. Exposed as a query hook too so callers that only need
 * a read (e.g. `WorkspaceLockGate` resolving the Business plan id to start
 * checkout) don't have to duplicate the fetch.
 */
export function useBillingPlans(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...billingKeys.all, 'plans-page'] as const,
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{
        data?: { plans: Billing.BillingPlan[]; subscription: Billing.Subscription | null };
      }>('/billing/plans-page');
      return res.data ?? { plans: [], subscription: null };
    },
    enabled,
  });
}

export function useInvoices(limit?: number) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.invoices(limit),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({ limit });
      return client.get<{ data: unknown[] }>(`/billing/invoices${query}`);
    },
  });
}
export function usePlanLimits() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.limits(),
    queryFn: async () => {
      const client = await getClient();
      // The endpoint bundles current-plan feature flags (e.g. removeBranding)
      // alongside the usage limits — Billing.PlanLimits only models the latter.
      return client.get<{ data: (Billing.PlanLimits & { removeBranding?: boolean }) | null }>('/billing/limits');
    },
  });
}

/**
 * Phone-number subscription cost, for the billing page's phone-cost row.
 *
 * Served by app-api `GET /billing/phone-subscription`, which proxies to
 * billing-worker (Stripe is the source of truth for `totalMonthly`). The
 * browser never calls billing-worker directly.
 *
 * Kept wrapped in `{ data }` because the billing page reads `phoneSubData?.data`.
 */
export function usePhoneSubscription() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.phoneSubscription(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: PhoneSubscriptionResponse }>('/billing/phone-subscription');
    },
  });
}

// =============================================================================
// Credits Queries
// =============================================================================

export function useCreditsBalance() {
  // Canonical credits surface lives in app-api (prepaid wallet semantics).
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.balance(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: unknown }>('/credits/balance');
    },
  });
}export function useCreditPackages() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.packages(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: unknown[] }>('/credits/packages');
    },
  });
}// =============================================================================
// Billing Mutations
// =============================================================================

export function useChangePlan() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    // `/api/billing/checkout` validates `{ planId, seats, cycle }` and answers
    // `{ data: { url } }`. Callers historically disagreed on the field names
    // (pricing-dialog sends seatCount/billingCycle, billing-settings-section sends
    // seats/cycle), so normalize here rather than churn call sites, and unwrap the
    // envelope so `result.url` keeps working exactly as it did on the legacy worker.
    mutationFn: async (data: Record<string, unknown>) => {
      const client = await getClient();
      const body = {
        planId: data.planId,
        seats: data.seats ?? data.seatCount,
        cycle: data.cycle ?? (data.billingCycle === 'annually' ? 'yearly' : data.billingCycle),
        ...(data.successUrl ? { successUrl: data.successUrl } : {}),
        ...(data.cancelUrl ? { cancelUrl: data.cancelUrl } : {}),
      };
      // `success` is never actually returned (neither worker has a free-plan branch —
      // checkout always answers `{ url }`), but callers still guard on it, so the type
      // stays wide enough for that dead branch.
      const res = await client.post<{ data: { url?: string; success?: boolean } }>(
        '/billing/checkout',
        body,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.all });
    },
  });
}

export function useUpdateSeats() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    // The route is POST (not PATCH) and takes `{ seatCount }` on both workers — the
    // old PATCH + `{ seats }` call never matched anything. The hook's `{ seats }`
    // argument stays as-is for callers; it maps to the wire name here. The reply is
    // re-shaped to the legacy top-level `{ success, purchasedSeats, paymentUrl? }`
    // that billing-settings-section reads.
    mutationFn: async (data: { seats: number }) => {
      const client = await getClient();
      const res = await client.post<{
        data: { purchasedSeats: number; paymentRequired?: boolean; paymentUrl?: string | null };
      }>('/billing/seats', { seatCount: data.seats });
      return { success: true, ...res.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
      qc.invalidateQueries({ queryKey: billingKeys.limits() });
    },
  });
}

export function useCancelSubscription() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      // Unwrapped to the legacy top-level `{ success: true }`.
      const res = await client.post<{ data: { success: boolean } }>('/billing/cancel', {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
  });
}

export function useReactivateSubscription() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const res = await client.post<{ data: { success: boolean } }>('/billing/reactivate', {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
  });
}// =============================================================================
// Payment Methods
//
// Stripe is the source of truth — there is no local mirror, so every mutation
// invalidates the list rather than patching a cached copy.
// =============================================================================

export function usePaymentMethods(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.paymentMethods(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: BillingPaymentMethodResponse[] }>(
        '/billing/payment-methods',
      );
      return res.data ?? [];
    },
    enabled,
  });
}

/**
 * Create a SetupIntent and return its client secret for Stripe Elements.
 *
 * Deliberately a mutation, not a query: each secret backs one confirmation
 * attempt, so it is minted when the dialog opens rather than cached.
 */
export function useCreateSetupIntent() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const res = await client.post<{ data: { clientSecret: string } }>(
        '/billing/payment-methods/setup-intent',
        {},
      );
      return res.data;
    },
  });
}

export function useSetDefaultPaymentMethod() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentMethodId: string) => {
      const client = await getClient();
      // `partial` is true when the customer default was written but at least
      // one live subscription rejected it — those keep charging the old method.
      const res = await client.post<{
        data: { success: boolean; id: string; partial: boolean };
      }>(`/billing/payment-methods/${paymentMethodId}/default`, {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.paymentMethods() });
      // The paywall gate keys off whether a method is on file.
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
  });
}

export function useRemovePaymentMethod() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentMethodId: string) => {
      const client = await getClient();
      await client.delete(`/billing/payment-methods/${paymentMethodId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.paymentMethods() });
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
  });
}

/**
 * Start a prepaid credit topup — redirects the browser to Stripe Checkout.
 * On success the caller receives `{ url }` and should navigate to it.
 *
 * Goes through app-api `POST /credits/checkout` (proxied to billing-worker).
 */
export function useBuyCredits() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (packageId: string) => {
      const client = await getClient();
      const res = await client.post<{ data: { url: string } }>('/credits/checkout', {
        packageId,
        successUrl: `${window.location.origin}/settings/billing?credits=success`,
        cancelUrl: `${window.location.origin}/settings/billing?credits=cancelled`,
      });
      return res.data;
    },
  });
}