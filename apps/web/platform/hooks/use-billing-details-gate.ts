import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiErrorCode } from '@/lib/partner/api-errors';

/** `POST /billing/checkout` and `POST /credits/checkout` answer this until the billing details are complete (Mollie). */
export function isBillingDetailsRequired(err: unknown): boolean {
  return apiErrorCode(err) === 'BILLING_DETAILS_REQUIRED';
}

/**
 * Billing details before a Mollie checkout: a plan or a credit top-up is
 * refused with 400 `BILLING_DETAILS_REQUIRED` until they are complete. The
 * refused action is kept, the billing details dialog opens, and the action
 * runs again once the dialog saves; closing the dialog drops it.
 *
 * Spread `dialogProps` onto `BillingDetailsDialog`.
 */
export function useBillingDetailsGate(message: string) {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);

  /** True when `err` asked for billing details: the dialog opens and `retry` waits for it. */
  const intercept = useCallback(
    (err: unknown, retry: () => void): boolean => {
      if (!isBillingDetailsRequired(err)) return false;
      pending.current = retry;
      toast.info(message);
      setOpen(true);
      return true;
    },
    [message],
  );

  const dialogProps = useMemo(
    () => ({
      open,
      onOpenChange: (next: boolean) => {
        setOpen(next);
        if (!next) pending.current = null;
      },
      // The dialog calls this before it closes itself.
      onSaved: () => {
        const retry = pending.current;
        pending.current = null;
        retry?.();
      },
    }),
    [open],
  );

  return { intercept, dialogProps };
}
