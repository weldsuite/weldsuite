import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  creditCheckoutStatusSchema,
  type CreditCheckoutStatus,
} from '@weldsuite/app-api-client/schemas/credits';
import { useAppApiClient } from '@/lib/api/use-app-api';

/**
 * Coming back from a credit checkout. Stripe (Global) returns to the success
 * or the cancel URL (`?credits=success|cancelled`). Mollie (the Kubernetes
 * editions) has one address for every outcome but an explicit cancel, so the
 * server adds the checkout's id (`&checkout=ctp_…`) and the page asks it how
 * the payment ended (`GET /credits/checkout/:id`).
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

/** Which message a checkout's state gets. */
export function checkoutToast(status: CreditCheckoutStatus['status'] | null): CheckoutToast {
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

function show(kind: CheckoutToast, strings: CheckoutReturnStrings): void {
  if (kind === 'success') toast.success(strings.purchaseSuccess);
  else if (kind === 'cancelled') toast.info(strings.purchaseCancelled);
  else if (kind === 'failed') toast.error(strings.purchaseNotCompleted);
  else toast.info(strings.purchasePending);
}

/**
 * Shows how the credit checkout this page was returned to ended, then strips
 * its parameters from the URL. A Mollie checkout is looked up; the balance is
 * refetched once it is known.
 */
export function useCreditCheckoutReturn(strings: CheckoutReturnStrings): void {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    const found = readCheckoutReturn(window.location.search);
    if (!found) return;
    window.history.replaceState({}, '', `${window.location.pathname}${withoutCheckoutParams(window.location.search)}`);

    const { checkoutId, outcome } = found;
    if (!checkoutId) {
      if (outcome === 'success') show('success', strings);
      else if (outcome === 'cancelled') show('cancelled', strings);
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
  }, [getClient, queryClient, strings]);
}
