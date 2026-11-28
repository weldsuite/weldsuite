// Client-safe formatting for the billing screens. Dates are pinned to UTC for
// the same reason as workspaces/workspace-presentation.tsx: these strings are
// server-rendered and then hydrated in the viewer's zone.

import type { AdminCopy } from './i18n';
import { ssoActionLabel } from './sso-copy';
import { mollieActionLabel } from './mollie-billing-copy';

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

/** Subscription status → label; unknown statuses fall through as-is. */
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
  'staff.add': 'staffAdd',
  'staff.remove': 'staffRemove',
  'flag.set': 'flagSet',
  'flag.clear': 'flagClear',
};

export function actionLabel(t: AdminCopy, action: string): string {
  const key = ACTION_KEYS[action];
  if (key) return t.activity.actions[key];
  return ssoActionLabel(action) ?? mollieActionLabel(action) ?? action;
}

/**
 * An amount typed in major units to minor units: "75" → 7500, "49.50" → 4950,
 * "49,5" → 4950. Null when it is not a plain amount with at most two decimals.
 * Integer arithmetic, so no float rounding creeps in.
 */
export function parseMajorUnitsToCents(input: string): number | null {
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** 7500 → "75", 4950 → "49.50": a saved price as the amount field shows it. */
export function centsToMajorUnits(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0')}`;
}
