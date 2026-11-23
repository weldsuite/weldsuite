/**
 * Phase 6 on a CRM company: the buyers (role, spend limit, status), the forms
 * that invite and edit them, and the approval threshold, in the shapes the
 * screens and the API share.
 */

import { z } from 'zod';
import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type { ApprovalActor } from '@/hooks/queries/use-commerce-orders-queries';
import type { Buyer, BuyerInput, BuyerPatch, BuyerRole, BuyerStatus } from '@/hooks/queries/use-commerce-buyers-queries';
import { getTranslations } from '@/lib/i18n';
import { apiErrorInfo } from './orders';
import { fromCents, toCents } from './payments';

export const BUYER_ROLES: readonly BuyerRole[] = ['buyer', 'approver', 'admin'];

const STATUS_TONES: Record<BuyerStatus, SoftTone> = { invited: 'warning', active: 'success', disabled: 'neutral' };

export function buyerStatusTone(status: BuyerStatus): SoftTone {
  return STATUS_TONES[status] ?? 'neutral';
}

/** A value in the UI language; one this version doesn't know, as stored. */
function word(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value.replace(/_/g, ' ');
}

export function buyerRoleLabel(role: BuyerRole): string {
  return word(getTranslations('commerce').buyers.role, role);
}

export function buyerRoleHint(role: BuyerRole): string {
  return word(getTranslations('commerce').buyers.roleHint, role);
}

export function buyerStatusLabel(status: BuyerStatus): string {
  return word(getTranslations('commerce').buyers.status, status);
}

/** The name of a buyer, else the email; the screens never show an empty title. */
export function buyerDisplayName(buyer: Pick<Buyer, 'name' | 'email'>): string {
  return buyer.name?.trim() || buyer.email;
}

/** Who asked for or decided an approval: the name, else the email, else nothing. */
export function approvalActorName(actor: ApprovalActor | null | undefined): string | null {
  return actor?.name?.trim() || actor?.email?.trim() || null;
}

// ---------------------------------------------------------------------------
// Amounts and currencies
// ---------------------------------------------------------------------------

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/** "1500" and " 1500.5 " as "1500.00"; an empty value as ""; anything else as typed. */
export function normalizeAmount(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const cents = toCents(trimmed);
  return Number.isNaN(cents) ? trimmed : fromCents(cents);
}

/** The cents of a decimal string, null for none (or for something that is no amount). */
function centsOrNull(value: string | null | undefined): number | null {
  const cents = toCents(value);
  return Number.isNaN(cents) ? null : cents;
}

/**
 * Checks an optional amount with its currency: empty is fine (no limit), an
 * amount needs to be positive with at most two decimals and a three-letter
 * currency.
 */
export function limitIssues(amount: string, currency: string, ctx: z.RefinementCtx, amountPath: string, currencyPath: string): void {
  const t = getTranslations('commerce').buyers.form;
  const trimmed = amount.trim();
  if (trimmed === '') return;
  const cents = toCents(trimmed);
  if (Number.isNaN(cents)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [amountPath], message: t.spendInvalid });
  else if (cents <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [amountPath], message: t.spendZero });
  if (!CURRENCY_CODE.test(currency.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [currencyPath], message: t.currencyInvalid });
  }
}

/** An amount that sits next to its currency (money in): the amount and the currency, or both null. */
export function amountWithCurrency(amount: string, currency: string): { amount: string | null; currency: string | null } {
  const normalized = normalizeAmount(amount);
  if (normalized === '') return { amount: null, currency: null };
  return { amount: normalized, currency: currency.trim().toUpperCase() };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface InviteFormValues {
  email: string;
  firstName: string;
  lastName: string;
  role: BuyerRole;
  spendLimit: string;
  currency: string;
  sendInvite: boolean;
}

export interface EditFormValues {
  role: BuyerRole;
  spendLimit: string;
  currency: string;
  disabled: boolean;
}

export function buildInviteSchema() {
  const t = getTranslations('commerce').buyers.form;
  return z
    .object({
      email: z.string().trim().min(1, t.emailRequired).email(t.emailInvalid).max(254),
      firstName: z.string().trim().max(100),
      lastName: z.string().trim().max(100),
      role: z.enum(['buyer', 'approver', 'admin']),
      spendLimit: z.string(),
      currency: z.string(),
      sendInvite: z.boolean(),
    })
    .superRefine((values, ctx) => limitIssues(values.spendLimit, values.currency, ctx, 'spendLimit', 'currency'));
}

export function buildEditSchema() {
  return z
    .object({
      role: z.enum(['buyer', 'approver', 'admin']),
      spendLimit: z.string(),
      currency: z.string(),
      disabled: z.boolean(),
    })
    .superRefine((values, ctx) => limitIssues(values.spendLimit, values.currency, ctx, 'spendLimit', 'currency'));
}

export function emptyInviteValues(currency: string): InviteFormValues {
  return { email: '', firstName: '', lastName: '', role: 'buyer', spendLimit: '', currency, sendInvite: true };
}

export function editValuesFromBuyer(buyer: Buyer, defaultCurrency: string): EditFormValues {
  return {
    role: buyer.role,
    spendLimit: buyer.spendLimit ?? '',
    currency: buyer.spendLimitCurrency ?? defaultCurrency,
    disabled: buyer.status === 'disabled',
  };
}

export function toInviteInput(companyId: string, values: InviteFormValues): BuyerInput {
  const limit = amountWithCurrency(values.spendLimit, values.currency);
  const input: BuyerInput = {
    companyId,
    email: values.email.trim(),
    role: values.role,
    sendInvite: values.sendInvite,
  };
  if (values.firstName.trim()) input.firstName = values.firstName.trim();
  if (values.lastName.trim()) input.lastName = values.lastName.trim();
  if (limit.amount) {
    input.spendLimit = limit.amount;
    input.spendLimitCurrency = limit.currency;
  }
  return input;
}

/** The status a buyer takes when a member switches Disabled on or off: back to where it was before. */
function statusAfter(buyer: Buyer, disabled: boolean): BuyerStatus {
  if (disabled) return 'disabled';
  if (buyer.status !== 'disabled') return buyer.status;
  return buyer.acceptedAt ? 'active' : 'invited';
}

/** Only what changed; an empty patch means there is nothing to send. */
export function toBuyerPatch(buyer: Buyer, values: EditFormValues): BuyerPatch {
  const patch: BuyerPatch = {};
  if (values.role !== buyer.role) patch.role = values.role;

  const limit = amountWithCurrency(values.spendLimit, values.currency);
  const sameAmount = centsOrNull(limit.amount) === centsOrNull(buyer.spendLimit);
  const sameCurrency = limit.currency === (buyer.spendLimitCurrency?.toUpperCase() ?? null);
  if (!sameAmount || !sameCurrency) {
    patch.spendLimit = limit.amount;
    patch.spendLimitCurrency = limit.currency;
  }

  const status = statusAfter(buyer, values.disabled);
  if (status !== buyer.status) patch.status = status;
  return patch;
}

/** A failed buyer call in words: `LAST_ADMIN` in the UI language, anything else as the server worded it. */
export function buyerErrorMessage(err: unknown, fallback: string): string {
  const { code, message } = apiErrorInfo(err);
  if (code === 'LAST_ADMIN') return getTranslations('commerce').buyers.errors.lastAdmin;
  return message ?? (err instanceof Error && err.message ? err.message : fallback);
}
