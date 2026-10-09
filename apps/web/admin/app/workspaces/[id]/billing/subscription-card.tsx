'use client';

import { useState } from 'react';
import { AlertTriangle, ExternalLink, Gift, Receipt } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ActionDialog } from '@/components/billing/action-dialog';
import { endComp, reactivateSubscription, removeDiscount } from '@/actions/billing';
import { adminCopy, fill } from '@/lib/i18n';
import {
  formatCents,
  formatDay,
  isLiveSubscription,
  paymentMethodLabel,
  statusLabel,
  statusTone,
} from '@/lib/billing-format';
import type { PlanOption, SnapshotState, WorkspaceBilling } from '@/lib/billing-types';
import { CancelDialog, ChangePlanDialog, CompDialog, DiscountDialog, TrialDialog } from './subscription-dialogs';

type DialogKind =
  | 'change'
  | 'cancel'
  | 'reactivate'
  | 'trial'
  | 'discount'
  | 'removeDiscount'
  | 'comp'
  | 'endComp';

export function SubscriptionCard({
  billing,
  snapshotState,
  plans,
  canWrite,
}: Readonly<{
  billing: WorkspaceBilling;
  snapshotState: SnapshotState;
  plans: PlanOption[];
  canWrite: boolean;
}>) {
  const t = adminCopy();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => setDialog(null);

  const snapshot = snapshotState.kind === 'ok' ? snapshotState.snapshot : null;
  const sub = snapshot?.subscription ?? null;
  const live = sub && isLiveSubscription(sub.status) ? sub : null;
  const workerReady = snapshotState.kind === 'ok';
  const actionsEnabled = canWrite && workerReady;
  const comped = billing.comp !== null;
  const status = comped ? 'comped' : (sub?.status ?? billing.subscriptionStatus);
  const cycle = sub?.interval === 'year' || billing.subscriptionCycle === 'yearly' ? 'yearly' : 'monthly';
  const openInvoice = sub?.latestInvoice?.status === 'open' && sub.latestInvoice.amountDueCents > 0 ? sub.latestInvoice : null;

  const rows: Array<[string, React.ReactNode]> = [
    [t.subscription.plan, billing.planName ?? t.subscription.noPlan],
    [t.subscription.cycle, cycle === 'yearly' ? t.subscription.yearly : t.subscription.monthly],
    [t.subscription.seats, billing.purchasedSeats],
  ];
  if (sub?.unitAmountCents != null) {
    rows.push([
      t.subscription.price,
      fill(t.subscription.pricePerSeat, {
        amount: formatCents(sub.unitAmountCents, sub.currency),
        interval: sub.interval === 'year' ? t.subscription.intervalYear : t.subscription.intervalMonth,
      }),
    ]);
  }
  if (sub?.trialEnd && sub.status === 'trialing') rows.push([t.subscription.trialEnds, formatDay(sub.trialEnd)]);
  if (live?.cancelAtPeriodEnd || billing.cancelAtPeriodEnd) {
    rows.push([t.subscription.cancelsOn, formatDay(live?.cancelAt ?? live?.currentPeriodEnd ?? billing.currentPeriodEnd)]);
  } else if (live?.currentPeriodEnd ?? billing.currentPeriodEnd) {
    rows.push([t.subscription.periodEnds, formatDay(live?.currentPeriodEnd ?? billing.currentPeriodEnd)]);
  }
  if (live) {
    rows.push([
      t.subscription.collection,
      live.collectionMethod === 'send_invoice'
        ? fill(t.subscription.sendInvoice, { days: live.daysUntilDue ?? 30 })
        : t.subscription.chargeAutomatically,
    ]);
    rows.push([
      t.subscription.paymentMethod,
      paymentMethodLabel(t, live.paymentMethod ?? snapshot?.customer?.defaultPaymentMethod ?? null),
    ]);
    rows.push([t.subscription.automaticTax, live.automaticTax ? t.common.on : t.common.off]);
  }
  if (live?.discount) {
    const d = live.discount;
    rows.push([
      t.subscription.discount,
      d.endsAt ? fill(t.subscription.discountUntil, { name: d.name ?? d.couponId, date: formatDay(d.endsAt) }) : (d.name ?? d.couponId),
    ]);
  }
  if (snapshot?.customer && snapshot.customer.balanceCents !== 0) {
    const balance = snapshot.customer.balanceCents;
    rows.push([
      t.subscription.customerBalance,
      fill(balance < 0 ? t.subscription.customerCredit : t.subscription.customerOwes, {
        amount: formatCents(Math.abs(balance), snapshot.customer.currency),
      }),
    ]);
  }

  const compPlan = plans.find((p) => p.id === billing.planId);

  return (
    <div className="space-y-3">
      {snapshotState.kind === 'not_configured' && (
        <Notice tone="warning">{t.subscription.workerNotConfigured}</Notice>
      )}
      {snapshotState.kind === 'error' && (
        <Notice tone="warning">{fill(t.subscription.workerUnreachable, { message: snapshotState.message })}</Notice>
      )}
      {snapshot && snapshot.errors.length > 0 && (
        <Notice tone="warning">{fill(t.subscription.snapshotFailed, { message: snapshot.errors.join(' · ') })}</Notice>
      )}
      {billing.paywallDeletionAt && !comped && (
        <Notice tone="destructive">
          {fill(t.subscription.paywall, {
            trialEnded: formatDay(billing.trialExpiredAt),
            deletesOn: formatDay(billing.paywallDeletionAt),
          })}
        </Notice>
      )}

      {billing.comp && (
        <Card className="border-emerald-500/30 bg-emerald-500/5 py-4">
          <CardContent className="flex items-start justify-between gap-4 px-4">
            <div className="flex gap-3">
              <Gift className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="space-y-0.5 text-sm">
                <div className="font-medium">{t.comp.bannerTitle}</div>
                <div>
                  {fill(t.comp.bannerBody, { plan: compPlan?.name ?? billing.planName ?? '—', seats: billing.purchasedSeats })}{' '}
                  {billing.comp.endsAt ? fill(t.comp.endsOn, { date: formatDay(billing.comp.endsAt) }) : t.comp.noEnd}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fill(t.comp.grantedBy, {
                    email: billing.comp.grantedBy ?? '—',
                    date: formatDay(billing.comp.grantedAt),
                  })}
                  {billing.comp.reason ? ` “${billing.comp.reason}”` : ''}
                </div>
              </div>
            </div>
            {actionsEnabled && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => setDialog('comp')}>
                  {t.comp.editTitle}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('endComp')}>
                  {t.comp.end}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">{t.subscription.title}</h2>
              <Badge variant={comped ? 'success' : statusTone(status)}>{statusLabel(t, status)}</Badge>
            </div>
            {sub && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {t.subscription.stripe}: {sub.id}
              </span>
            )}
          </div>

          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>

          {!sub && !comped && snapshot && (
            <p className="text-sm text-muted-foreground">{t.subscription.noSubscription}</p>
          )}

          {openInvoice && (
            <Notice tone="warning">
              {fill(t.subscription.openInvoice, { amount: formatCents(openInvoice.amountDueCents, openInvoice.currency) })}{' '}
              {openInvoice.hostedUrl && (
                <a href={openInvoice.hostedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                  {t.subscription.payInvoice}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </Notice>
          )}

          {actionsEnabled && (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {!comped && (
                <Button size="sm" onClick={() => setDialog('change')}>
                  {live ? t.subscription.actions.changePlan : t.subscription.actions.startSubscription}
                </Button>
              )}
              {live && !comped && (
                <Button size="sm" variant="outline" onClick={() => setDialog('trial')}>
                  {t.subscription.actions.setTrial}
                </Button>
              )}
              {live && !live.discount && (
                <Button size="sm" variant="outline" onClick={() => setDialog('discount')}>
                  {t.subscription.actions.addDiscount}
                </Button>
              )}
              {live?.discount && (
                <Button size="sm" variant="outline" onClick={() => setDialog('removeDiscount')}>
                  {t.subscription.actions.removeDiscount}
                </Button>
              )}
              {live?.cancelAtPeriodEnd && (
                <Button size="sm" variant="outline" onClick={() => setDialog('reactivate')}>
                  {t.subscription.actions.reactivate}
                </Button>
              )}
              {!comped && (
                <Button size="sm" variant="outline" onClick={() => setDialog('comp')}>
                  {t.subscription.actions.grantComp}
                </Button>
              )}
              {live && !live.cancelAtPeriodEnd && (
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDialog('cancel')}>
                  {t.subscription.actions.cancel}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {dialog === 'change' && (
        <ChangePlanDialog workspaceId={billing.workspaceId} billing={billing} snapshot={snapshot} plans={plans} onClose={close} />
      )}
      {dialog === 'cancel' && (
        <CancelDialog
          workspaceId={billing.workspaceId}
          billing={billing}
          periodEnd={live?.currentPeriodEnd ?? billing.currentPeriodEnd}
          onClose={close}
        />
      )}
      {dialog === 'trial' && (
        <TrialDialog workspaceId={billing.workspaceId} currentTrialEnd={live?.trialEnd ?? null} onClose={close} />
      )}
      {dialog === 'discount' && (
        <DiscountDialog workspaceId={billing.workspaceId} currency={live?.currency ?? 'eur'} onClose={close} />
      )}
      {dialog === 'comp' && (
        <CompDialog workspaceId={billing.workspaceId} billing={billing} plans={plans} onClose={close} />
      )}
      {dialog === 'reactivate' && (
        <ActionDialog
          title={t.reactivate.title}
          description={t.reactivate.description}
          submitLabel={t.reactivate.submit}
          successMessage={t.reactivate.success}
          onClose={close}
          onSubmit={(reason, requestId) => reactivateSubscription(billing.workspaceId, { reason }, requestId)}
        />
      )}
      {dialog === 'removeDiscount' && (
        <ActionDialog
          title={t.discount.removeTitle}
          description={t.discount.removeDescription}
          submitLabel={t.discount.removeSubmit}
          successMessage={t.discount.removeSuccess}
          onClose={close}
          onSubmit={(reason, requestId) => removeDiscount(billing.workspaceId, { reason }, requestId)}
        />
      )}
      {dialog === 'endComp' && (
        <ActionDialog
          destructive
          title={t.comp.endTitle}
          description={t.comp.endDescription}
          submitLabel={t.comp.endSubmit}
          successMessage={t.comp.endSuccess}
          onClose={close}
          onSubmit={(reason, requestId) => endComp(billing.workspaceId, { reason }, requestId)}
        />
      )}
    </div>
  );
}

const NOTICE_TONE = {
  warning: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
} as const;

function Notice({ tone, children }: Readonly<{ tone: keyof typeof NOTICE_TONE; children: React.ReactNode }>) {
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${NOTICE_TONE[tone]}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
