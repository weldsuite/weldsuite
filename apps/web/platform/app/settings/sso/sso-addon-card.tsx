import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { SsoBillingView } from '@weldsuite/app-api-client/schemas/sso';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCancelSso, useResumeSso, useSsoBilling, useSubscribeSso } from '@/hooks/queries/use-sso-queries';
import { formatBillingAmount } from '@/app/settings/billing/billing-details';
import { InlineError, Notice } from './sso-parts';
import { isPaymentMethodRequired, ssoErrorMessage } from './sso-errors';
import { formatSsoDate, ssoAddonState, type SsoAddonState } from './sso-view';

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

  let body: ReactNode;
  if (isLoading) {
    body = <Skeleton className="h-16 w-full" />;
  } else if (isError || !billing) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{copy.loadFailed}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          {ts.retry}
        </Button>
      </div>
    );
  } else {
    body = (
      <AddonBody
        billing={billing}
        canManageBilling={canManageBilling}
        busy={busy}
        subscribing={subscribe.isPending}
        resuming={resume.isPending}
        onAdd={() => setDialog('add')}
        onCancel={() => setDialog('cancel')}
        onResume={() => void run(() => resume.mutateAsync(), copy.resumed)}
      />
    );
  }

  const cancelDate = billing?.subscription ? formatSsoDate(billing.subscription.currentPeriodEnd, language) : '';
  const chargePrice = billing ? monthlyPrice(billing, format, copy.pricePerMonth, language) : '';

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

type Format = ReturnType<typeof useI18n>['format'];
type Language = ReturnType<typeof useI18n>['language'];

/** "€100 / month" in the currency the workspace is charged in. */
function monthlyPrice(billing: SsoBillingView, format: Format, template: string, language: Language): string {
  return format(template, {
    price: formatBillingAmount(billing.price.unitAmountCents, billing.price.currency, language),
  });
}

interface AddonBodyProps {
  billing: SsoBillingView;
  canManageBilling: boolean;
  busy: boolean;
  subscribing: boolean;
  resuming: boolean;
  onAdd: () => void;
  onCancel: () => void;
  onResume: () => void;
}

/** The card's content for each add-on state. */
function AddonBody(props: Readonly<AddonBodyProps>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.addon;
  const { billing, canManageBilling } = props;
  const state = ssoAddonState(billing);
  const price = monthlyPrice(billing, format, copy.pricePerMonth, language);

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

    case 'subscribed':
      return <SubscribedAddon {...props} state={state} price={price} />;

    case 'purchasable':
      return <PurchasableAddon {...props} state={state} price={price} />;

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
              <OwnerOnly />
            )
          }
        />
      );

    case 'partner':
      return <Summary title={ts.title} lines={[copy.partner]} />;

    case 'unavailable':
      return <Summary title={ts.title} lines={[copy.unavailable]} />;
  }
}

/** Shown in place of billing buttons to someone without `billing:manage`. */
function OwnerOnly() {
  const { t } = useI18n();
  return <p className="text-sm text-muted-foreground">{t.settings.sso.addon.ownerOnly}</p>;
}

type SubscribedState = Extract<SsoAddonState, { kind: 'subscribed' }>;

function SubscribedAddon({
  billing,
  canManageBilling,
  busy,
  resuming,
  onCancel,
  onResume,
  state,
  price,
}: Readonly<AddonBodyProps & { state: SubscribedState; price: string }>) {
  const { t, language, format } = useI18n();
  const copy = t.settings.sso.addon;

  const date = formatSsoDate(state.currentPeriodEnd, language);
  const lines: string[] = [];
  if (state.cancelAtPeriodEnd) {
    if (date) lines.push(format(copy.endsOn, { date }));
    lines.push(copy.endsOnDescription);
  } else if (date) {
    lines.push(format(copy.renewsOn, { date }));
  }
  if (billing.price.custom) lines.push(copy.customPrice);

  let actions: ReactNode = <OwnerOnly />;
  if (canManageBilling && state.unpaid) {
    actions = (
      <Button asChild size="sm">
        <Link href="/settings/billing">{copy.payInvoice}</Link>
      </Button>
    );
  } else if (canManageBilling && state.cancelAtPeriodEnd) {
    actions = (
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onResume}>
        {resuming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {copy.resume}
      </Button>
    );
  } else if (canManageBilling) {
    actions = (
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
        {copy.cancel}
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <Summary title={price} badge={<SubscriptionBadge state={state} />} lines={lines} actions={actions} />
      {state.unpaid && <Notice tone="warning">{copy.unpaidDescription}</Notice>}
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

/** Active, retrying a failed payment, or overdue (SSO off until paid). */
function SubscriptionBadge({ state }: Readonly<{ state: SubscribedState }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.addon;
  if (state.unpaid) return <Badge variant="destructive">{copy.unpaid}</Badge>;
  if (state.pastDue) return <Badge variant="warning">{copy.pastDue}</Badge>;
  return <Badge variant="success">{copy.active}</Badge>;
}

type PurchasableState = Extract<SsoAddonState, { kind: 'purchasable' }>;

function PurchasableAddon({
  billing,
  canManageBilling,
  busy,
  subscribing,
  onAdd,
  state,
  price,
}: Readonly<AddonBodyProps & { state: PurchasableState; price: string }>) {
  const { t } = useI18n();
  const copy = t.settings.sso.addon;

  let actions: ReactNode = <OwnerOnly />;
  if (canManageBilling && state.hasPaymentMethod) {
    actions = (
      <Button type="button" size="sm" disabled={busy} onClick={onAdd}>
        {subscribing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {copy.add}
      </Button>
    );
  } else if (canManageBilling) {
    actions = (
      <Button asChild size="sm">
        <Link href="/settings/billing">{copy.addPaymentMethod}</Link>
      </Button>
    );
  }

  return (
    <Summary
      title={price}
      lines={[
        copy.purchasableDescription,
        ...(billing.price.custom ? [copy.customPrice] : []),
        ...(state.hasPaymentMethod ? [] : [copy.needsCard]),
      ]}
      actions={actions}
    />
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
