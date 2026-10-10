'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import {
  applyDiscount,
  cancelSubscription,
  changeSubscription,
  grantComp,
  previewSubscriptionChange,
  setTrialEnd,
} from '@/actions/billing';
import { adminCopy, fill } from '@/lib/i18n';
import { formatCents, formatDay, formatDecimal, isLiveSubscription } from '@/lib/billing-format';
import type {
  CollectionMethod,
  InvoicePreview,
  PlanOption,
  ProrationBehavior,
  StripeSnapshot,
  SubscriptionCycle,
  WorkspaceBilling,
} from '@/lib/billing-types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `YYYY-MM-DD` from a date input → midnight UTC of that day, as ISO. */
function dayToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoToDay(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

function parseWholeNumber(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

function PlanSelect({
  id,
  plans,
  value,
  onChange,
}: Readonly<{ id: string; plans: PlanOption[]; value: string; onChange: (planId: string) => void }>) {
  const t = adminCopy();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={t.subscription.noPlan} />
      </SelectTrigger>
      <SelectContent>
        {plans.map((plan) => (
          <SelectItem key={plan.id} value={plan.id}>
            {plan.name} · {formatDecimal(plan.priceMonthly, plan.currency)} {t.plans.perSeat}
            {plan.isActive ? '' : ` (${t.plans.hidden})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ============================================================================
// Change plan / start subscription
// ============================================================================

export function ChangePlanDialog({
  workspaceId,
  billing,
  snapshot,
  plans,
  onClose,
}: Readonly<{
  workspaceId: string;
  billing: WorkspaceBilling;
  snapshot: StripeSnapshot | null;
  plans: PlanOption[];
  onClose: () => void;
}>) {
  const t = adminCopy();
  const live = snapshot?.subscription && isLiveSubscription(snapshot.subscription.status) ? snapshot.subscription : null;
  const hasCard = Boolean(snapshot?.customer?.defaultPaymentMethod);

  const [planId, setPlanId] = useState(billing.planId ?? plans[0]?.id ?? '');
  const [cycle, setCycle] = useState<SubscriptionCycle>(billing.subscriptionCycle === 'yearly' ? 'yearly' : 'monthly');
  const [seats, setSeats] = useState(String(Math.max(billing.purchasedSeats, 1)));
  const [proration, setProration] = useState<ProrationBehavior>('always_invoice');
  const [collection, setCollection] = useState<CollectionMethod | 'keep'>(
    live ? 'keep' : hasCard ? 'charge_automatically' : 'send_invoice',
  );
  const [daysUntilDue, setDaysUntilDue] = useState('14');
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [isPreviewing, startPreview] = useTransition();

  const plan = plans.find((p) => p.id === planId);
  const seatCount = parseWholeNumber(seats);
  const dueDays = parseWholeNumber(daysUntilDue);

  const invalid = useMemo(() => {
    if (!plan) return t.subscription.noPlan;
    if (!(cycle === 'yearly' ? plan.hasYearlyPrice : plan.hasMonthlyPrice)) {
      return fill(t.changePlan.noStripePrice, { cycle: cycle === 'yearly' ? t.subscription.yearly : t.subscription.monthly });
    }
    if (seatCount === null || seatCount < 1) return t.plans.form.wholeNumber;
    if (plan.maxUsers && seatCount > plan.maxUsers) return fill(t.changePlan.seatsHint, { max: plan.maxUsers });
    if (collection === 'send_invoice' && (dueDays === null || dueDays < 1 || dueDays > 90)) return t.plans.form.wholeNumber;
    return null;
  }, [plan, cycle, seatCount, collection, dueDays, t]);

  const input = () => ({
    planId,
    cycle,
    seats: seatCount ?? 1,
    proration,
    ...(collection === 'keep' ? {} : { collectionMethod: collection }),
    ...(collection === 'send_invoice' ? { daysUntilDue: dueDays ?? 14 } : {}),
  });

  const runPreview = () =>
    startPreview(async () => {
      const result = await previewSubscriptionChange(workspaceId, input());
      if (result.ok) setPreview(result.data);
      else toast.error(result.error);
    });

  // Any change to the inputs makes an earlier preview stale.
  const update = <V,>(setter: (v: V) => void) => (value: V) => {
    setter(value);
    setPreview(null);
  };

  return (
    <ActionDialog
      wide
      title={live ? t.changePlan.title : t.changePlan.titleNew}
      description={live ? t.changePlan.description : t.changePlan.descriptionNew}
      submitLabel={live ? t.changePlan.submit : t.changePlan.submitNew}
      invalidMessage={invalid}
      onClose={onClose}
      onSubmit={(reason, requestId) => changeSubscription(workspaceId, { ...input(), reason }, requestId)}
      successMessage={(data) => (data.created ? t.changePlan.successNew : t.changePlan.success)}
    >
      <Field label={t.changePlan.plan} htmlFor="change-plan-plan">
        <PlanSelect id="change-plan-plan" plans={plans} value={planId} onChange={update(setPlanId)} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t.changePlan.cycle}>
          <RadioGroup value={cycle} onValueChange={(v) => update(setCycle)(v as SubscriptionCycle)} className="gap-2">
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="monthly" id="change-plan-monthly" />
              {t.subscription.monthly}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="yearly" id="change-plan-yearly" />
              {t.subscription.yearly}
            </label>
          </RadioGroup>
        </Field>
        <Field
          label={t.changePlan.seats}
          htmlFor="change-plan-seats"
          hint={plan?.maxUsers ? fill(t.changePlan.seatsHint, { max: plan.maxUsers }) : undefined}
        >
          <Input
            id="change-plan-seats"
            inputMode="numeric"
            value={seats}
            onChange={(e) => update(setSeats)(e.target.value)}
          />
        </Field>
      </div>

      {live && (
        <Field label={t.changePlan.proration} htmlFor="change-plan-proration">
          <Select value={proration} onValueChange={(v) => update(setProration)(v as ProrationBehavior)}>
            <SelectTrigger id="change-plan-proration" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always_invoice">{t.changePlan.prorationAlwaysInvoice}</SelectItem>
              <SelectItem value="create_prorations">{t.changePlan.prorationCreate}</SelectItem>
              <SelectItem value="none">{t.changePlan.prorationNone}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label={t.changePlan.collection} htmlFor="change-plan-collection">
          <Select value={collection} onValueChange={(v) => setCollection(v as CollectionMethod | 'keep')}>
            <SelectTrigger id="change-plan-collection" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {live && <SelectItem value="keep">{t.changePlan.keepCollection}</SelectItem>}
              <SelectItem value="charge_automatically" disabled={!hasCard}>
                {t.changePlan.chargeAutomatically}
              </SelectItem>
              <SelectItem value="send_invoice">{t.changePlan.sendInvoice}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {collection === 'send_invoice' && (
          <Field label={t.changePlan.daysUntilDue} htmlFor="change-plan-due">
            <Input
              id="change-plan-due"
              inputMode="numeric"
              className="w-24"
              value={daysUntilDue}
              onChange={(e) => setDaysUntilDue(e.target.value)}
            />
          </Field>
        )}
      </div>

      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{t.changePlan.previewTitle}</span>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(invalid) || isPreviewing} onClick={runPreview}>
            {isPreviewing ? t.common.working : t.changePlan.preview}
          </Button>
        </div>
        {preview && !preview.available && (
          <p className="mt-2 text-xs text-muted-foreground">{t.changePlan.previewUnavailable}</p>
        )}
        {preview?.available && (
          <div className="mt-2 space-y-1 text-xs">
            {preview.lines.map((line, i) => (
              <div key={`${i}-${line.description}`} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{line.description}</span>
                <span className="tabular-nums">{formatCents(line.amountCents, preview.currency)}</span>
              </div>
            ))}
            <div className="flex justify-between gap-4 border-t pt-1 font-medium">
              <span>{t.changePlan.previewTotal}</span>
              <span className="tabular-nums">{formatCents(preview.amountDueCents, preview.currency)}</span>
            </div>
          </div>
        )}
      </div>
    </ActionDialog>
  );
}

// ============================================================================
// Cancel
// ============================================================================

export function CancelDialog({
  workspaceId,
  billing,
  periodEnd,
  onClose,
}: Readonly<{ workspaceId: string; billing: WorkspaceBilling; periodEnd: string | null; onClose: () => void }>) {
  const t = adminCopy();
  const [mode, setMode] = useState<'period_end' | 'immediately'>('period_end');

  return (
    <ActionDialog
      destructive
      title={t.cancel.title}
      description={t.cancel.description}
      submitLabel={t.cancel.submit}
      onClose={onClose}
      successMessage={mode === 'immediately' ? t.cancel.success : t.cancel.successPeriodEnd}
      onSubmit={(reason, requestId) => cancelSubscription(workspaceId, { mode, reason }, requestId)}
    >
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="gap-3">
        <label className="flex items-start gap-2 text-sm">
          <RadioGroupItem value="period_end" id="cancel-period-end" className="mt-0.5" />
          <span>
            <span className="font-medium">{t.cancel.periodEnd}</span>
            <span className="block text-xs text-muted-foreground">
              {fill(t.cancel.periodEndHint, { date: formatDay(periodEnd) })}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <RadioGroupItem value="immediately" id="cancel-immediately" className="mt-0.5" />
          <span>
            <span className="font-medium">{t.cancel.immediately}</span>
            <span className="block text-xs text-muted-foreground">
              {billing.comp ? t.cancel.compHint : t.cancel.immediatelyHint}
            </span>
          </span>
        </label>
      </RadioGroup>
    </ActionDialog>
  );
}

// ============================================================================
// Trial end
// ============================================================================

export function TrialDialog({
  workspaceId,
  currentTrialEnd,
  onClose,
}: Readonly<{ workspaceId: string; currentTrialEnd: string | null; onClose: () => void }>) {
  const t = adminCopy();
  const [day, setDay] = useState(isoToDay(currentTrialEnd) || daysFromNow(14));
  const iso = dayToIso(day);
  const valid =
    iso !== null &&
    new Date(iso).getTime() >= Date.now() + HOUR_MS &&
    new Date(iso).getTime() <= Date.now() + 730 * DAY_MS;

  return (
    <ActionDialog
      title={t.trial.title}
      description={t.trial.description}
      submitLabel={t.trial.submit}
      invalidMessage={valid ? null : t.trial.invalid}
      onClose={onClose}
      successMessage={t.trial.success}
      onSubmit={(reason, requestId) => setTrialEnd(workspaceId, { trialEnd: iso!, reason }, requestId)}
    >
      <Field label={t.trial.trialEnd} htmlFor="trial-end">
        <Input id="trial-end" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}

// ============================================================================
// Discount
// ============================================================================

export function DiscountDialog({
  workspaceId,
  currency,
  onClose,
}: Readonly<{ workspaceId: string; currency: string; onClose: () => void }>) {
  const t = adminCopy();
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [duration, setDuration] = useState<'once' | 'repeating' | 'forever'>('repeating');
  const [months, setMonths] = useState('3');

  const amount = Number.parseFloat(value.replace(',', '.'));
  const monthCount = parseWholeNumber(months);
  const valueValid =
    /^\d+([.,]\d{1,2})?$/.test(value.trim()) && amount > 0 && (kind === 'fixed' || amount <= 100);
  const monthsValid = duration !== 'repeating' || (monthCount !== null && monthCount >= 1 && monthCount <= 36);

  return (
    <ActionDialog
      title={t.discount.title}
      description={t.discount.description}
      submitLabel={t.discount.submit}
      invalidMessage={value === '' ? null : valueValid && monthsValid ? null : t.discount.invalid}
      onClose={onClose}
      successMessage={t.discount.success}
      onSubmit={(reason, requestId) => {
        if (!valueValid || !monthsValid) return Promise.resolve({ ok: false as const, error: t.discount.invalid });
        return applyDiscount(
          workspaceId,
          {
            ...(kind === 'percent' ? { percentOff: amount } : { amountOffCents: Math.round(amount * 100) }),
            duration,
            ...(duration === 'repeating' ? { durationInMonths: monthCount ?? 1 } : {}),
            reason,
          },
          requestId,
        );
      }}
    >
      <Field label={t.discount.type}>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as typeof kind)} className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="percent" id="discount-percent" />
            {t.discount.percent}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="fixed" id="discount-fixed" />
            {t.discount.fixed}
          </label>
        </RadioGroup>
      </Field>

      <Field
        label={kind === 'percent' ? t.discount.percentOff : fill(t.discount.amountOff, { currency: currency.toUpperCase() })}
        htmlFor="discount-value"
      >
        <Input id="discount-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field label={t.discount.duration} htmlFor="discount-duration">
          <Select value={duration} onValueChange={(v) => setDuration(v as typeof duration)}>
            <SelectTrigger id="discount-duration" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">{t.discount.once}</SelectItem>
              <SelectItem value="repeating">{t.discount.repeating}</SelectItem>
              <SelectItem value="forever">{t.discount.forever}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {duration === 'repeating' && (
          <Field label={t.discount.months} htmlFor="discount-months">
            <Input
              id="discount-months"
              inputMode="numeric"
              className="w-20"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </Field>
        )}
      </div>
    </ActionDialog>
  );
}

// ============================================================================
// Comp plan
// ============================================================================

export function CompDialog({
  workspaceId,
  billing,
  plans,
  onClose,
}: Readonly<{ workspaceId: string; billing: WorkspaceBilling; plans: PlanOption[]; onClose: () => void }>) {
  const t = adminCopy();
  const editing = Boolean(billing.comp);
  const [planId, setPlanId] = useState(billing.planId ?? plans[0]?.id ?? '');
  const [seats, setSeats] = useState(String(billing.purchasedSeats));
  const [endsOn, setEndsOn] = useState(isoToDay(billing.comp?.endsAt));
  const [cancelStripe, setCancelStripe] = useState(true);

  const plan = plans.find((p) => p.id === planId);
  const seatCount = parseWholeNumber(seats);
  const endsAt = endsOn ? dayToIso(endsOn) : null;
  const endsValid = !endsOn || (endsAt !== null && new Date(endsAt).getTime() >= Date.now() + HOUR_MS);

  const invalid = !plan
    ? t.subscription.noPlan
    : seatCount === null
      ? t.plans.form.wholeNumber
      : plan.maxUsers && seatCount > plan.maxUsers
        ? fill(t.changePlan.seatsHint, { max: plan.maxUsers })
        : endsValid
          ? null
          : t.comp.endsAtInvalid;

  return (
    <ActionDialog
      title={editing ? t.comp.editTitle : t.comp.title}
      description={t.comp.description}
      submitLabel={editing ? t.comp.submitEdit : t.comp.submit}
      invalidMessage={invalid}
      onClose={onClose}
      successMessage={t.comp.success}
      onSubmit={(reason, requestId) =>
        grantComp(
          workspaceId,
          {
            planId,
            seats: seatCount ?? 0,
            endsAt,
            cancelStripeSubscription: Boolean(billing.stripeSubscriptionId) && cancelStripe,
            reason,
          },
          requestId,
        )
      }
    >
      <Field label={t.comp.plan} htmlFor="comp-plan">
        <PlanSelect id="comp-plan" plans={plans} value={planId} onChange={setPlanId} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.comp.seats} htmlFor="comp-seats">
          <Input id="comp-seats" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} />
        </Field>
        <Field label={t.comp.endsAt} htmlFor="comp-ends">
          <Input id="comp-ends" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t.comp.endsAtHint}</p>

      {billing.stripeSubscriptionId && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            id="comp-cancel-stripe"
            checked={cancelStripe}
            onCheckedChange={(v) => setCancelStripe(v === true)}
            className="mt-0.5"
          />
          <span>
            {t.comp.cancelStripe}
            <span className="block text-xs text-muted-foreground">{t.comp.cancelStripeHint}</span>
          </span>
        </label>
      )}
    </ActionDialog>
  );
}
