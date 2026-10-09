// Client-safe formatting for the billing screens. Dates are pinned to UTC for
// the same reason as workspaces/workspace-presentation.tsx: these strings are
// server-rendered and then hydrated in the viewer's zone.

import type { AdminCopy } from './i18n';
import type { PaymentMethodSummary } from './billing-types';
import { fill } from './i18n';

/** 1250 + "eur" → "€12.50". */
export function formatCents(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents == null) return '—';
  return formatAmount(cents / 100, currency);
}

/** "12.50" + "EUR" → "€12.50". */
export function formatDecimal(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return '—';
  return formatAmount(Number.parseFloat(amount), currency);
}

function formatAmount(value: number, currency: string | null | undefined): string {
  const code = (currency ?? 'EUR').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;
}

export function formatCredits(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

/** Stripe subscription status → label; unknown statuses fall through as-is. */
export function statusLabel(t: AdminCopy, status: string | null | undefined): string {
  if (!status) return t.status.none;
  return (t.status as Record<string, string>)[status] ?? status;
}

export function statusTone(status: string | null | undefined): 'success' | 'warning' | 'secondary' | 'destructive' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'success';
    case 'past_due':
    case 'incomplete':
    case 'paused':
      return 'warning';
    case 'unpaid':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export function paymentMethodLabel(t: AdminCopy, pm: PaymentMethodSummary | null): string {
  if (!pm) return t.subscription.noPaymentMethod;
  if (pm.type === 'card' && pm.brand) {
    return fill(t.subscription.cardSummary, {
      brand: pm.brand[0]!.toUpperCase() + pm.brand.slice(1),
      last4: pm.last4 ?? '????',
      month: String(pm.expMonth ?? '').padStart(2, '0'),
      year: String(pm.expYear ?? '').slice(-2),
    });
  }
  return fill(t.subscription.otherMethodSummary, { type: pm.type.replace(/_/g, ' '), last4: pm.last4 ?? '????' });
}

/** `subscription.change` → the `activity.actions` key `subscriptionChange`. */
const ACTION_KEYS: Record<string, keyof AdminCopy['activity']['actions']> = {
  'subscription.change': 'subscriptionChange',
  'subscription.cancel': 'subscriptionCancel',
  'subscription.reactivate': 'subscriptionReactivate',
  'subscription.trial': 'subscriptionTrial',
  'discount.apply': 'discountApply',
  'discount.remove': 'discountRemove',
  'comp.grant': 'compGrant',
  'comp.end': 'compEnd',
  'comp.expire': 'compExpire',
  'credits.adjust': 'creditsAdjust',
  'payment.refund': 'paymentRefund',
  'invoice.void': 'invoiceVoid',
  'plan.create': 'planCreate',
  'plan.update': 'planUpdate',
  'plan.sync': 'planSync',
  'workspace.deletion_schedule': 'deletionSchedule',
  'workspace.deletion_cancel': 'deletionCancel',
};

export function actionLabel(t: AdminCopy, action: string): string {
  const key = ACTION_KEYS[action];
  return key ? t.activity.actions[key] : action;
}

/** A fresh idempotency key for one form submission. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Failures after which the write may still have happened (timeout, worker or
 * Stripe 5xx). A retry must reuse the same request id so Stripe replays the
 * first result instead of charging, refunding or subscribing twice. Anything
 * else is a definite rejection and gets a fresh id.
 */
const AMBIGUOUS_FAILURES = new Set(['UNREACHABLE', 'UPSTREAM', 'INTERNAL', 'STRIPE_UNAVAILABLE']);

export function keepsRequestId(code: string | undefined): boolean {
  return code !== undefined && AMBIGUOUS_FAILURES.has(code);
}

/**
 * Subscription states whose plan can still be changed. Mirrors the billing
 * worker's LIVE_SUBSCRIPTION_STATUSES: Stripe cannot change an `incomplete`
 * subscription, so the console starts a new one instead.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

export function isLiveSubscription(status: string | null | undefined): boolean {
  return status != null && LIVE_SUBSCRIPTION_STATUSES.has(status);
}
