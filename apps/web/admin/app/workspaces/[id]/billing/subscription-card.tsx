'use client';

import { AlertTriangle, Gift, Receipt } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { adminCopy, fill } from '@/lib/i18n';
import { formatDay, statusLabel, statusTone } from '@/lib/billing-format';
import type { PlanOption, WorkspaceBilling } from '@/lib/billing-types';
import { mollieBillingCopy } from '@/lib/mollie-billing-copy';

/**
 * The workspace's plan as the master database has it. Read-only: billing
 * changes run from the CLI, except the seat price on the Mollie card.
 */
export function SubscriptionCard({
  billing,
  plans,
  canWrite,
}: Readonly<{
  billing: WorkspaceBilling;
  plans: PlanOption[];
  canWrite: boolean;
}>) {
  const t = adminCopy();
  const comped = billing.comp !== null;
  const status = comped ? 'comped' : billing.subscriptionStatus;

  const rows: Array<[string, React.ReactNode]> = [
    [t.subscription.plan, billing.planName ?? t.subscription.noPlan],
    [t.subscription.cycle, billing.subscriptionCycle === 'yearly' ? t.subscription.yearly : t.subscription.monthly],
    [t.subscription.seats, billing.purchasedSeats],
  ];
  if (billing.cancelAtPeriodEnd) {
    rows.push([t.subscription.cancelsOn, formatDay(billing.currentPeriodEnd)]);
  } else if (billing.currentPeriodEnd) {
    rows.push([t.subscription.periodEnds, formatDay(billing.currentPeriodEnd)]);
  }

  const compPlan = plans.find((p) => p.id === billing.planId);

  return (
    <div className="space-y-3">
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
          <CardContent className="flex gap-3 px-4">
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
          </CardContent>
        </Card>
      )}

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.subscription.title}</h2>
            <Badge variant={comped ? 'success' : statusTone(status)}>{statusLabel(t, status)}</Badge>
          </div>

          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>

          {canWrite && (
            <p className="border-t pt-4 text-xs text-muted-foreground">{mollieBillingCopy().readOnlyHint}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const NOTICE_TONE = {
  destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
} as const;

export function Notice({ tone, children }: Readonly<{ tone: keyof typeof NOTICE_TONE; children: React.ReactNode }>) {
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${NOTICE_TONE[tone]}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
