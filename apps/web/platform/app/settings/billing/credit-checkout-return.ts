import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  creditCheckoutStatusSchema,
  type CreditCheckoutStatus,
} from '@weldsuite/app-api-client/schemas/credits';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { BillingCheckoutStatusResponse } from '@/lib/api/domains/billing';

/**
 * Coming back from a credit checkout. Stripe (Global) returns to the success
 * or the cancel URL (`?credits=success|cancelled`). Mollie (the Kubernetes
 * editions) has one address for every outcome but an explicit cancel, so the
 * server adds the checkout's id (`&checkout=ctp_…`) and the page asks it how
 * the payment ended (`GET /credits/checkout/:id`).
 *
 * Plan billing on Mollie returns to the same page the same way, with ids that
 * start with `bpy_` (plan checkout, plan change, new payment method, pay link):
 * those are looked up at `GET /billing/checkout/:id` instead.
 */
export interface CheckoutReturn {
  /** `?credits=`: what the return URL itself claims. */
  outcome: 'success' | 'cancelled' | null;
  /** `?checkout=`: a Mollie checkout to look up. */
  checkoutId: string | null;
}

/** The checkout this page was returned to from, or null when none. */
export function readCheckoutReturn(search: string): CheckoutReturn | null {
  const params = new URLSearchParams(search);
  const credits = params.get('credits');
  const checkoutId = params.get('checkout')?.trim() || null;
  const outcome = credits === 'success' || credits === 'cancelled' ? credits : null;
  if (!credits && !checkoutId) return null;
  return { outcome, checkoutId };
}

/** `search` without the checkout parameters, so a refresh doesn't toast again. */
export function withoutCheckoutParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('credits');
  params.delete('checkout');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export type CheckoutToast = 'success' | 'pending' | 'cancelled' | 'failed';

/** Billing checkout ids (Mollie plan billing) start with this; credit top-ups use `ctp_`. */
export const BILLING_CHECKOUT_PREFIX = 'bpy_';

export function isBillingCheckoutId(id: string): boolean {
  return id.startsWith(BILLING_CHECKOUT_PREFIX);
}

/** Which message a checkout's state gets. */
export function checkoutToast(
  status: CreditCheckoutStatus['status'] | BillingCheckoutStatusResponse['status'] | null,
): CheckoutToast {
  switch (status) {
    case 'paid':
      return 'success';
    case 'canceled':
      return 'cancelled';
    case 'expired':
    case 'failed':
      return 'failed';
    default:
      // Still open, a bank transfer under way, or not known (yet): the
      // credits arrive once the payment provider confirms it.
      return 'pending';
  }
}

export interface CheckoutReturnStrings {
  purchaseSuccess: string;
  purchaseCancelled: string;
  purchasePending: string;
  purchaseNotCompleted: string;
}

/** What a paid billing checkout says, by what it was for. */
export interface BillingCheckoutReturnStrings {
  planPaid: string;
  changePaid: string;
  mandatePaid: string;
  payLinkPaid: string;
  pending: string;
  cancelled: string;
  notCompleted: string;
  /** A pay link opened for a charge that is no longer open (`?pay=done`). */
  payLinkDone?: string;
  /** A pay link that expired (`?pay=expired`). */
  payLinkExpired?: string;
}

/**
 * A pay link (`/public/billing/pay/:token`) sends the browser back to the
 * billing page with `?pay=done` (nothing is open any more) or `?pay=expired`.
 */
export function readPayLinkReturn(search: string): 'done' | 'expired' | null {
  const pay = new URLSearchParams(search).get('pay');
  return pay === 'done' || pay === 'expired' ? pay : null;
}

function showBilling(
  status: BillingCheckoutStatusResponse['status'] | null,
  purpose: BillingCheckoutStatusResponse['purpose'] | null,
  strings: BillingCheckoutReturnStrings,
): void {
  const kind = checkoutToast(status);
  if (kind === 'success') {
    const paid: Record<BillingCheckoutStatusResponse['purpose'], string> = {
      checkout: strings.planPaid,
      change: strings.changePaid,
      mandate: strings.mandatePaid,
      pay_link: strings.payLinkPaid,
    };
    toast.success(paid[purpose ?? 'checkout']);
  } else if (kind === 'cancelled') toast.info(strings.cancelled);
  else if (kind === 'failed') toast.error(strings.notCompleted);
  else toast.info(strings.pending);
}

function show(kind: CheckoutToast, strings: CheckoutReturnStrings): void {
  if (kind === 'success') toast.success(strings.purchaseSuccess);
  else if (kind === 'cancelled') toast.info(strings.purchaseCancelled);
  else if (kind === 'failed') toast.error(strings.purchaseNotCompleted);
  else toast.info(strings.purchasePending);
}

/**
 * Shows how the credit checkout this page was returned to ended, then strips
 * its parameters from the URL. A Mollie checkout is looked up; the balance is
 * refetched once it is known. With `billingStrings` (the billing page), a
 * `bpy_` plan-billing checkout is looked up too and the billing queries are
 * refreshed.
 */
export function useCreditCheckoutReturn(
  strings: CheckoutReturnStrings,
  billingStrings?: BillingCheckoutReturnStrings,
): void {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    const pay = billingStrings ? readPayLinkReturn(window.location.search) : null;
    if (billingStrings && pay) {
      const params = new URLSearchParams(window.location.search);
      params.delete('pay');
      const rest = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
      const message = pay === 'done' ? billingStrings.payLinkDone : billingStrings.payLinkExpired;
      if (message) toast.info(message);
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
    }
    const found = readCheckoutReturn(window.location.search);
    if (!found) return;
    window.history.replaceState({}, '', `${window.location.pathname}${withoutCheckoutParams(window.location.search)}`);

    const { checkoutId, outcome } = found;
    if (!checkoutId) {
      if (outcome === 'success') show('success', strings);
      else if (outcome === 'cancelled') show('cancelled', strings);
      return;
    }
    if (billingStrings && isBillingCheckoutId(checkoutId)) {
      void (async () => {
        let status: BillingCheckoutStatusResponse['status'] | null = null;
        let purpose: BillingCheckoutStatusResponse['purpose'] | null = null;
        try {
          const client = await getClient();
          const res = await client.get<{ data?: BillingCheckoutStatusResponse }>(
            `/billing/checkout/${encodeURIComponent(checkoutId)}`,
          );
          status = res.data?.status ?? null;
          purpose = res.data?.purpose ?? null;
        } catch {
          // Unreadable: say it is being processed; the refreshed page shows the rest.
        }
        showBilling(status, purpose, billingStrings);
        void queryClient.invalidateQueries({ queryKey: ['billing'] });
      })();
      return;
    }
    void (async () => {
      let status: CreditCheckoutStatus['status'] | null = null;
      try {
        const client = await getClient();
        const res = await client.get<{ data: unknown }>(`/credits/checkout/${encodeURIComponent(checkoutId)}`);
        const parsed = creditCheckoutStatusSchema.safeParse(res.data);
        if (parsed.success) status = parsed.data.status;
      } catch {
        // Unreadable: say it is being processed; the balance shows the rest.
      }
      show(checkoutToast(status), strings);
      void queryClient.invalidateQueries({ queryKey: ['credits'] });
    })();
    // A later run finds the parameters gone and does nothing.
  }, [getClient, queryClient, strings, billingStrings]);
}
