
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { billingWorkerApi } from '@/lib/api/billing-worker-client';
import type { BillingSubscriptionResponse } from '@/lib/api/domains/billing';
import type { Billing } from '@/lib/api/types/apps/billing.types';

// =============================================================================
// Query Keys
// =============================================================================

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  invoices: (limit?: number) => [...billingKeys.all, 'invoices', limit] as const,
  payments: (filters?: Record<string, any>) => [...billingKeys.all, 'payments', filters] as const,
  limits: () => [...billingKeys.all, 'limits'] as const,
  phoneSubscription: () => [...billingKeys.all, 'phone-subscription'] as const,
};

const creditsKeys = {
  all: ['credits'] as const,
  balance: () => [...creditsKeys.all, 'balance'] as const,
  transactions: (filters?: Record<string, any>) => [...creditsKeys.all, 'transactions', filters] as const,
  availability: (amount: number) => [...creditsKeys.all, 'availability', amount] as const,
  packages: () => [...creditsKeys.all, 'packages'] as const,
  rates: () => [...creditsKeys.all, 'rates'] as const,
  usage: () => [...creditsKeys.all, 'usage'] as const,
  subscription: () => [...creditsKeys.all, 'subscription'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, any>): string {
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
      return client.get<{ data: any[] }>(`/billing/invoices${query}`);
    },
  });
}

function usePayments(limit?: number, page?: number) {
  const filters = { limit, page };
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.payments(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters);
      return client.get<{ data: any[] }>(`/billing/payments${query}`);
    },
  });
}

export function usePlanLimits() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: billingKeys.limits(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/billing/limits');
    },
  });
}

/**
 * Phone-number subscription cost, for the billing page's phone-cost row.
 *
 * `/billing/phone-subscription` never existed on ANY worker, so this 404'd and
 * the row rendered empty. The real implementation is the billing-worker's
 * `GET /api/billing/phone/subscription` — it reads the Stripe subscription off
 * `workspaces.stripePhoneSubscriptionId` and returns exactly the
 * `PhoneSubscriptionResponse` this page consumes. `billingWorkerApi` is already
 * the client for it and is already used in this file (see `useBuyCredits`), so
 * point at it rather than rebuild phone billing in app-api.
 *
 * Not ported to app-api on purpose: `GET /billing/phone-numbers` (tenant DB)
 * has no price column at all, so `totalMonthly` cannot be derived there without
 * inventing prices — and this figure is money shown on a billing page.
 *
 * Kept wrapped in `{ data }` because the billing page reads `phoneSubData?.data`.
 */
export function usePhoneSubscription() {
  return useQuery({
    queryKey: billingKeys.phoneSubscription(),
    queryFn: async () => {
      const data = await billingWorkerApi.getPhoneSubscription();
      return { data };
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
      return client.get<{ data: any }>('/credits/balance');
    },
  });
}

function useCreditsTransactions(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.transactions(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: any[] }>(`/credits/transactions${query}`);
    },
  });
}

// `GET /credits/availability?amount=` never existed on either worker — the real
// route is `POST /credits/check { amount }` (identical on api-worker and app-api).
// Repointed; the hook's argument and query key are unchanged.
function useCreditsAvailability(amount: number, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.availability(amount),
    queryFn: async () => {
      const client = await getClient();
      return client.post<{ data: any }>('/credits/check', { amount });
    },
    enabled: amount > 0 && enabled,
  });
}

export function useCreditPackages() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.packages(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>('/credits/packages');
    },
  });
}

function useCreditRates() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.rates(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/credits/rates');
    },
  });
}

function useCreditsUsage() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.usage(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/credits/usage');
    },
  });
}

function useSubscriptionCredits() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: creditsKeys.subscription(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/credits/subscription');
    },
  });
}

// =============================================================================
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
    mutationFn: async (data: Record<string, any>) => {
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
    mutationFn: async (data?: Record<string, any>) => {
      const client = await getClient();
      // Unwrapped to the legacy top-level `{ success: true }`.
      const res = await client.post<{ data: { success: boolean } }>('/billing/cancel', data || {});
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
    mutationFn: async (data?: Record<string, any>) => {
      const client = await getClient();
      const res = await client.post<{ data: { success: boolean } }>('/billing/reactivate', data || {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
  });
}

// =============================================================================
// Credits Mutations
// =============================================================================

function useUpdateSubscriptionCredits() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const client = await getClient();
      // POST, not PUT — `/credits/subscription` only registers POST (both workers).
      return client.post<{ data: any }>('/credits/subscription', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: creditsKeys.all });
    },
  });
}

function useAdjustCredits() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const client = await getClient();
      return client.post<{ data: any }>('/credits/adjust', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: creditsKeys.all });
    },
  });
}

/**
 * Start a prepaid credit topup — redirects the browser to Stripe Checkout.
 * On success the caller receives `{ url }` and should navigate to it.
 */
export function useBuyCredits() {
  return useMutation({
    mutationFn: async (packageId: string) => {
      return billingWorkerApi.createCreditTopupCheckout({
        packageId,
        successUrl: `${window.location.origin}/settings/billing?credits=success`,
        cancelUrl: `${window.location.origin}/settings/billing?credits=cancelled`,
      });
    },
  });
}

function useTriggerMonthlyAllocation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: any }>('/credits/allocate-monthly', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: creditsKeys.all });
    },
  });
}
