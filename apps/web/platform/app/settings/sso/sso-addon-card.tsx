import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCancelSso, useResumeSso, useSsoBilling, useSubscribeSso } from '@/hooks/queries/use-sso-queries';
import { formatBillingAmount } from '@/app/settings/billing/billing-details';
import { InlineError, Notice } from './sso-parts';
import { isPaymentMethodRequired, ssoErrorMessage } from './sso-errors';
import { formatSsoDate, ssoAddonState } from './sso-view';

type Dialog = 'add' | 'cancel' | null;

/**
 * The SSO add-on of the workspace: included in the plan, granted free, or a
 * monthly subscription that the workspace owner can start, cancel and resume.
 */
export function SsoAddonCard() {
  const { t, language, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.addon;
  const { can } = usePermissions();
  const canManageBilling = can('billing:manage');

  const { data: billing, isLoading, isError, refetch } = useSsoBilling();
  const subscribe = useSubscribeSso();
  const cancel = useCancelSso();
  const resume = useResumeSso();

  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = subscribe.isPending || cancel.isPending || resume.isPending;

  /** Runs one billing change; a failure stays on the card, where the person can act on it. */
  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await action();
      toast.success(success);
    } catch (err) {
      setError(err);
    } finally {
      setDialog(null);
    }
  };

  const body = (() => {
    if (isLoading) return <Skeleton className="h-16 w-full" />;
    if (isError || !billing) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{copy.loadFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {ts.retry}
          </Button>
        </div>
      );
    }

    const state = ssoAddonState(billing);
    const price = format(copy.pricePerMonth, {
      price: formatBillingAmount(billing.price.unitAmountCents, billing.price.currency, language),
    });
    const ownerOnly = <p className="text-sm text-muted-foreground">{copy.ownerOnly}</p>;

    switch (state.kind) {
      case 'included':
        return (
          <Summary
            title={ts.title}
            badge={<Badge variant="success">{copy.includedInPlan}</Badge>}
            lines={[copy.includedInPlanDescription]}
          />
        );

      case 'free-grant':
        return (
          <Summary
            title={ts.title}
            badge={<Badge variant="success">{copy.freeGrant}</Badge>}
            lines={[copy.freeGrantDescription]}
          />
        );

      case 'subscribed': {
        const date = formatSsoDate(state.currentPeriodEnd, language);
        const lines: string[] = [];
        if (state.cancelAtPeriodEnd) {
          if (date) lines.push(format(copy.endsOn, { date }));
          lines.push(copy.endsOnDescription);
        } else if (date) {
          lines.push(format(copy.renewsOn, { date }));
        }
        if (billing.price.custom) lines.push(copy.customPrice);
        return (
          <div className="space-y-3">
            <Summary
              title={price}
              badge={
                state.pastDue ? (
                  <Badge variant="warning">{copy.pastDue}</Badge>
                ) : (
                  <Badge variant="success">{copy.active}</Badge>
                )
              }
              lines={lines}
              actions={
                canManageBilling ? (
                  state.cancelAtPeriodEnd ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(() => resume.mutateAsync(), copy.resumed)}
                    >
                      {resume.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {copy.resume}
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog('cancel')}>
                      {copy.cancel}
                    </Button>
                  )
                ) : (
                  ownerOnly
                )
              }
            />
            {state.pastDue && (
              <Notice tone="warning">
                {copy.pastDueDescription}{' '}
                {canManageBilling && (
                  <Link href="/settings/billing" className="font-medium underline underline-offset-4">
                    {copy.addPaymentMethod}
                  </Link>
                )}
              </Notice>
            )}
            {state.includedInPlan && <Notice>{copy.includedInPlanNow}</Notice>}
          </div>
        );
      }

      case 'purchasable':
        return (
          <Summary
            title={price}
            lines={[
              copy.purchasableDescription,
              ...(billing.price.custom ? [copy.customPrice] : []),
              ...(state.hasPaymentMethod ? [] : [copy.needsCard]),
            ]}
            actions={
              canManageBilling ? (
                state.hasPaymentMethod ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => setDialog('add')}>
                    {subscribe.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {copy.add}
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href="/settings/billing">{copy.addPaymentMethod}</Link>
                  </Button>
                )
              ) : (
                ownerOnly
              )
            }
          />
        );

      case 'free-plan':
        return (
          <Summary
            title={ts.title}
            lines={[copy.freePlan]}
            actions={
              canManageBilling ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings/plans">{copy.viewPlans}</Link>
                </Button>
              ) : (
                ownerOnly
              )
            }
          />
        );

      case 'partner':
        return <Summary title={ts.title} lines={[copy.partner]} />;

      case 'unavailable':
        return <Summary title={ts.title} lines={[copy.unavailable]} />;
    }
  })();

  const cancelDate =
    billing && billing.subscription ? formatSsoDate(billing.subscription.currentPeriodEnd, language) : '';
  const chargePrice = billing
    ? format(copy.pricePerMonth, {
        price: formatBillingAmount(billing.price.unitAmountCents, billing.price.currency, language),
      })
    : '';

  return (
    <section aria-labelledby="sso-addon-heading">
      <h2 id="sso-addon-heading" className="mb-3 text-base font-semibold">
        {copy.title}
      </h2>
      <div className="space-y-3">
        <div className="rounded-xl border p-4 sm:p-5">{body}</div>
        {error !== null && (
          <InlineError>
            {ssoErrorMessage(error, ts.errors)}{' '}
            {isPaymentMethodRequired(error) && (
              <Link href="/settings/billing" className="font-medium underline underline-offset-4">
                {copy.addPaymentMethod}
              </Link>
            )}
          </InlineError>
        )}
      </div>

      <ConfirmDialog
        open={dialog === 'add'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={copy.confirmAdd.title}
        description={format(copy.confirmAdd.description, { price: chargePrice })}
        confirmLabel={copy.confirmAdd.confirm}
        cancelLabel={t.common.actions.cancel}
        onConfirm={() => run(() => subscribe.mutateAsync(), copy.added)}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={copy.confirmCancel.title}
        description={cancelDate ? format(copy.confirmCancel.description, { date: cancelDate }) : copy.confirmCancel.descriptionNoDate}
        confirmLabel={copy.confirmCancel.confirm}
        cancelLabel={copy.confirmCancel.keep}
        variant="destructive"
        onConfirm={() => run(() => cancel.mutateAsync(), copy.cancelled)}
      />
    </section>
  );
}

interface SummaryProps {
  title: string;
  badge?: ReactNode;
  lines: string[];
  actions?: ReactNode;
}

/** The add-on card's content: what it is and costs on the left, what can be done on the right. */
function Summary({ title, badge, lines, actions }: Readonly<SummaryProps>) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{title}</p>
          {badge}
        </div>
        {lines.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
