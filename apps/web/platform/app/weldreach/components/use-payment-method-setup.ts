/**
 * Adding a payment method for mailboxes: Stripe Checkout in setup mode, via
 * billing-worker. `start()` asks reach-api for a Checkout URL (success and
 * cancel come back to the page that asked) and sends the browser there.
 * `useBillingReturn()` picks up `?billing=done` on the way back.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { reachKeys, useReachBillingSetup } from '@/hooks/queries/use-reach-queries';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';

type ReturnPath = '/weldreach/setup' | '/weldreach/mailboxes' | '/weldreach/settings';

export function usePaymentMethodSetup(returnPath: ReturnPath, extraQuery: Record<string, string> = {}) {
  const t = useTranslations();
  const setup = useReachBillingSetup();
  const workspaceUrl = useWorkspaceUrl();
  const [redirecting, setRedirecting] = useState(false);

  const start = async () => {
    const urlWith = (params: Record<string, string>) => {
      const url = new URL(workspaceUrl(returnPath));
      for (const [key, value] of Object.entries({ ...extraQuery, ...params })) url.searchParams.set(key, value);
      return url.toString();
    };
    try {
      const res = await setup.mutateAsync({ successUrl: urlWith({ billing: 'done' }), cancelUrl: urlWith({}) });
      setRedirecting(true);
      window.location.assign(res.data.url);
    } catch {
      toast.error(t('reach.settings.billing.setupFailed'));
    }
  };

  return { start, isPending: setup.isPending || redirecting };
}

/** On the page Stripe returns to: refresh billing, say so, and drop `?billing=done`. */
export function useBillingReturn() {
  const t = useTranslations();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { billing?: string };
  const handled = useRef(false);

  useEffect(() => {
    if (search.billing !== 'done' || handled.current) return;
    handled.current = true;
    void qc.invalidateQueries({ queryKey: reachKeys.billing() });
    // Stripe confirms the card with a webhook; ask again once it has had time to arrive.
    window.setTimeout(() => void qc.invalidateQueries({ queryKey: reachKeys.billing() }), 3000);
    toast.success(t('reach.setup.payment.added'));
    void navigate({
      to: '.',
      search: ((previous: Record<string, unknown>) => ({ ...previous, billing: undefined })) as never,
      replace: true,
    });
  }, [search.billing, qc, navigate, t]);
}
