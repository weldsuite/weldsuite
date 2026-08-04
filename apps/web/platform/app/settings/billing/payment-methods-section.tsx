/**
 * Payment methods — settings → billing.
 *
 * Cards are collected by Stripe Elements against a SetupIntent minted by
 * app-api, so raw card data never touches WeldSuite. Stripe is also the only
 * store: "primary" is its own default payment method, read back on every
 * refetch rather than mirrored locally.
 *
 * iDEAL and Bancontact are offered alongside card and SEPA. Both are redirect
 * methods, so confirmation may navigate away and return to
 * `/settings/billing?setup_intent=…` — handled by the `redirect: 'if_required'`
 * branch plus the return-URL effect below.
 */

import { useEffect, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Appearance, type Stripe } from '@stripe/stripe-js';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { CreditCard, Landmark, Loader2, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import type { BillingPaymentMethodResponse } from '@/lib/api/domains/billing';
import {
  useCreateSetupIntent,
  usePaymentMethods,
  useRemovePaymentMethod,
  useSetDefaultPaymentMethod,
} from '@/hooks/queries/use-billing-queries';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n/provider';

/**
 * Stripe.js is loaded once per page load and shared by every dialog mount.
 * `loadStripe` is deliberately called outside the component — calling it on
 * each render would re-inject the script tag.
 */
const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
const stripePromise: Promise<Stripe | null> | null = publishableKey
  ? loadStripe(publishableKey)
  : null;

/** Card brands Stripe returns, mapped to the labels printed on the card. */
const CARD_BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

function formatBrand(method: BillingPaymentMethodResponse, sepaLabel: string): string {
  if (method.type === 'sepa_debit') return sepaLabel;
  if (!method.brand) return method.type;
  return CARD_BRAND_LABELS[method.brand] ?? method.brand;
}

function formatExpiry(method: BillingPaymentMethodResponse): string | null {
  if (!method.expMonth || !method.expYear) return null;
  return `${String(method.expMonth).padStart(2, '0')}/${String(method.expYear).slice(-2)}`;
}

/** `ApiError` from the shared client carries the HTTP status on `.status`. */
function isBadRequest(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 400;
}

/** True once the card's expiry month has fully passed. */
function isExpired(method: BillingPaymentMethodResponse): boolean {
  if (!method.expMonth || !method.expYear) return false;
  const now = new Date();
  const endOfExpiryMonth = new Date(method.expYear, method.expMonth, 1);
  return endOfExpiryMonth <= now;
}

// ============================================================================
// Add-method form (inside <Elements>, so it can use the Stripe hooks)
// ============================================================================

function AddPaymentMethodForm({
  onAdded,
  onCancel,
}: {
  /** Receives the saved payment method id so the caller can promote it. */
  onAdded: (paymentMethodId: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ts = t.settings.billing.paymentMethods;
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setErrorMessage(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setErrorMessage(submitError.message ?? ts.addFailed);
      setSubmitting(false);
      return;
    }

    // `if_required` keeps card and SEPA inline; iDEAL and Bancontact still
    // redirect, and come back to the return_url handled by the parent.
    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/settings/billing?payment_method=added`,
      },
      redirect: 'if_required',
    });

    if (confirmError) {
      setErrorMessage(confirmError.message ?? ts.addFailed);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);

    const savedId = setupIntent?.payment_method;
    onAdded(typeof savedId === 'string' ? savedId : (savedId?.id ?? null));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement options={{ layout: 'tabs' }} />

      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          {t.common.actions.cancel}
        </Button>
        <Button type="submit" disabled={!stripe || submitting}>
          {submitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          {ts.save}
        </Button>
      </div>
    </form>
  );
}

// ============================================================================
// Section
// ============================================================================

export function PaymentMethodsSection({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const ts = t.settings.billing.paymentMethods;
  const { resolvedTheme } = useTheme();

  const { data: methods = [], isLoading, refetch } = usePaymentMethods();
  const createSetupIntent = useCreateSetupIntent();
  const setDefaultMutation = useSetDefaultPaymentMethod();
  const removeMutation = useRemovePaymentMethod();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  // Elements is themed to match the app rather than inheriting Stripe's default
  // light palette, which reads as a broken panel in dark mode.
  const appearance: Appearance = useMemo(
    () => ({
      theme: resolvedTheme === 'dark' ? 'night' : 'stripe',
      variables: { borderRadius: '8px' },
    }),
    [resolvedTheme],
  );

  /**
   * Confirming a SetupIntent only attaches the method to the customer — Stripe
   * writes no default anywhere. Without this, a workspace adding its very first
   * method would end up with a saved card, no primary, and nothing selected on
   * its subscriptions at renewal. Later additions are left alone so an explicit
   * primary is never silently replaced.
   */
  const promoteIfNoPrimary = async (paymentMethodId: string | null) => {
    if (!paymentMethodId) return;

    const { data: latest } = await refetch();
    if (!latest || latest.length === 0 || latest.some((m) => m.isDefault)) return;

    try {
      await setDefaultMutation.mutateAsync(paymentMethodId);
    } catch {
      // The method is saved either way; the user can still promote it by hand.
      toast.error(ts.setPrimaryFailed);
    }
  };

  // Returning from an iDEAL/Bancontact redirect: Stripe has already saved the
  // mandate, so confirm it, promote it if it is the only one, and drop the
  // query params.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment_method') !== 'added') return;

    const clientSecretParam = params.get('setup_intent_client_secret');

    ['payment_method', 'setup_intent', 'setup_intent_client_secret', 'redirect_status'].forEach(
      (key) => params.delete(key),
    );
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);

    toast.success(ts.addSuccess);

    void (async () => {
      // The redirect carries no payment method id, so it is read back off the
      // SetupIntent before deciding whether to promote.
      const stripe = stripePromise ? await stripePromise : null;
      if (!stripe || !clientSecretParam) {
        void refetch();
        return;
      }

      const { setupIntent } = await stripe.retrieveSetupIntent(clientSecretParam);
      const savedId = setupIntent?.payment_method;
      await promoteIfNoPrimary(typeof savedId === 'string' ? savedId : (savedId?.id ?? null));
    })();
    // Runs once per redirect return — the query param is stripped above, so a
    // re-run cannot double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenDialog = async () => {
    if (!stripePromise) {
      toast.error(ts.stripeNotConfigured);
      return;
    }

    try {
      const { clientSecret: secret } = await createSetupIntent.mutateAsync();
      setClientSecret(secret);
      setDialogOpen(true);
    } catch {
      toast.error(ts.addFailed);
    }
  };

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    // Each client secret backs a single confirmation attempt — drop it on close
    // so reopening mints a fresh SetupIntent.
    if (!open) setClientSecret(null);
  };

  const handleAdded = (paymentMethodId: string | null) => {
    handleDialogChange(false);
    toast.success(ts.addSuccess);
    void promoteIfNoPrimary(paymentMethodId);
  };

  const handleSetDefault = async (id: string) => {
    try {
      const result = await setDefaultMutation.mutateAsync(id);
      // Some subscriptions kept the old method — saying "updated" outright
      // would be wrong, since those still renew on the previous card.
      toast[result.partial ? 'warning' : 'success'](
        result.partial ? ts.setPrimaryPartial : ts.setPrimarySuccess,
      );
    } catch {
      toast.error(ts.setPrimaryFailed);
    }
  };

  const handleRemove = async (method: BillingPaymentMethodResponse) => {
    if (!confirm(ts.removeConfirm)) return;
    try {
      await removeMutation.mutateAsync(method.id);
      toast.success(ts.removeSuccess);
    } catch (err) {
      // A 400 on DELETE has exactly one cause: the API refuses to detach the
      // primary method while a subscription is billing against it. Keyed on
      // status rather than the message text, which is server-side English.
      toast.error(isBadRequest(err) ? ts.removePrimaryBlocked : ts.removeFailed);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{ts.title}</h2>
          <span className="text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[18px] h-[18px] flex items-center justify-center rounded-[5px]">
            {methods.length}
          </span>
        </div>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenDialog}
            disabled={createSetupIntent.isPending}
          >
            {createSetupIntent.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-0.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5 mr-0.5" />
            )}
            {ts.addMethod}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">{ts.description}</p>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[13.5px]">{ts.method}</TableHead>
              <TableHead className="text-[13.5px]">{ts.expires}</TableHead>
              <TableHead className="text-[13.5px]">{ts.added}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline" />
                </TableCell>
              </TableRow>
            ) : methods.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {ts.empty}
                </TableCell>
              </TableRow>
            ) : (
              methods.map((method) => {
                const expiry = formatExpiry(method);
                const expired = isExpired(method);
                return (
                  <TableRow key={method.id}>
                    <TableCell className="h-[42px] py-0 px-3">
                      <div className="flex items-center gap-2">
                        {method.type === 'sepa_debit' ? (
                          <Landmark className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <CreditCard className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        )}
                        <span className="font-medium text-sm">
                          {formatBrand(method, ts.sepaDebit)}
                        </span>
                        {method.last4 && (
                          <span className="font-mono text-sm text-muted-foreground">
                            •••• {method.last4}
                          </span>
                        )}
                        {method.isDefault && (
                          <Badge variant="secondary" className="rounded-sm text-xs">
                            {ts.primary}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      {expiry ? (
                        <span
                          className={`text-sm ${expired ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                          {expiry}
                          {expired && ` · ${ts.expired}`}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      <span className="text-sm text-muted-foreground">
                        {method.createdAt
                          ? format(new Date(method.createdAt), 'MMM d, yyyy')
                          : '—'}
                      </span>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      {canManage && (
                        <div className="flex justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">{ts.rowActions}</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!method.isDefault && (
                                <DropdownMenuItem onClick={() => handleSetDefault(method.id)}>
                                  {ts.setPrimary}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => handleRemove(method)}
                              >
                                {t.common.actions.remove}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{ts.addMethod}</DialogTitle>
            <DialogDescription>{ts.addDescription}</DialogDescription>
          </DialogHeader>

          {stripePromise && clientSecret && (
            <Elements
              stripe={stripePromise}
              // Remounts Elements when a new secret is minted — Stripe does not
              // allow swapping clientSecret on a live instance.
              key={clientSecret}
              options={{ clientSecret, appearance }}
            >
              <AddPaymentMethodForm
                onAdded={handleAdded}
                onCancel={() => handleDialogChange(false)}
              />
            </Elements>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
