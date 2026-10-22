'use client';

import { useState } from 'react';
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
import {
  SSO_MAX_PRICE_CENTS,
  SSO_PRICE_CURRENCIES,
  type SsoAdminView,
  type SsoPriceCurrency,
} from '@weldsuite/app-api-client/schemas/sso';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { disableSsoConnection, grantSso, revokeSso } from '@/actions/billing';
import type { ActionResult } from '@/actions/workspaces';
import { fill } from '@/lib/i18n';
import { formatCents, formatDay } from '@/lib/billing-format';
import type { SsoAdminResult } from '@/lib/billing-types';
import { ssoCopy, type SsoCopy } from '@/lib/sso-copy';
import {
  canOfferSwitchOn,
  centsToMajorUnits,
  customPriceProblem,
  initialPriceCurrency,
  initialPriceMode,
  liveSsoSubscription,
  parseMajorUnitsToCents,
  ssoGrantRequest,
  type CustomPriceProblem,
  type SsoPriceMode,
} from '@/lib/sso-admin';
import { cn } from '@/lib/utils';

function problemMessage(t: SsoCopy, problem: CustomPriceProblem, currency: SsoPriceCurrency): string {
  switch (problem) {
    case 'format':
      return t.price.invalidAmount;
    case 'zero':
      return t.price.zeroAmount;
    case 'too_high':
      return fill(t.price.tooHigh, { max: formatCents(SSO_MAX_PRICE_CENTS, currency) });
  }
}

function grantSuccess(t: SsoCopy, result: SsoAdminResult): string {
  switch (result.action) {
    case 'created':
      return t.price.successCreated;
    case 'repriced':
      return t.price.successRepriced;
    case 'canceled':
      return t.price.successCanceled;
    default:
      return t.price.successSaved;
  }
}

function revokeSuccess(t: SsoCopy, result: SsoAdminResult): string {
  switch (result.action) {
    case 'canceled':
      return t.revoke.successCanceled;
    case 'scheduled_cancel':
      return t.revoke.successScheduled;
    default:
      return t.revoke.successCleared;
  }
}

/** A radio choice with a label and a hint underneath. */
function Choice({
  value,
  id,
  label,
  hint,
  disabled = false,
}: Readonly<{ value: string; id: string; label: string; hint?: string; disabled?: boolean }>) {
  return (
    <label className={cn('flex items-start gap-2 text-sm', disabled && 'cursor-not-allowed opacity-50')}>
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5" />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

// ============================================================================
// Set price
// ============================================================================

export function SsoPriceDialog({
  workspaceId,
  view,
  onClose,
}: Readonly<{ workspaceId: string; view: SsoAdminView; onClose: () => void }>) {
  const t = ssoCopy();
  const partner = view.billingMode === 'partner';
  const live = liveSsoSubscription(view);
  const savedCents = view.priceOverride?.unitAmountCents ?? 0;

  const [mode, setMode] = useState<SsoPriceMode>(() => initialPriceMode(view));
  const [amount, setAmount] = useState(savedCents > 0 ? centsToMajorUnits(savedCents) : '');
  const [currency, setCurrency] = useState<SsoPriceCurrency>(() => initialPriceCurrency(view));
  const [switchOn, setSwitchOn] = useState(false);

  const cents = parseMajorUnitsToCents(amount);
  const problem = mode === 'custom' && amount.trim() !== '' ? customPriceProblem(cents) : null;
  const request = ssoGrantRequest(view, { mode, cents, currency, switchOn });
  const offerSwitchOn = canOfferSwitchOn(view, mode);
  const listPrice = fill(t.perMonth, { amount: formatCents(view.listPrice.unitAmountCents, view.listPrice.currency) });

  const submit = async (reason: string, requestId: string): Promise<ActionResult<SsoAdminResult>> => {
    if (!request) return { ok: false, error: problemMessage(t, customPriceProblem(cents) ?? 'format', currency) };
    const result = await grantSso(workspaceId, { ...request, reason }, requestId);
    // The worker's message is written for the customer; say what staff can do instead.
    if (!result.ok && result.code === 'PAYMENT_METHOD_REQUIRED') return { ...result, error: t.price.noCard };
    return result;
  };

  return (
    <ActionDialog
      title={t.price.title}
      description={t.price.description}
      submitLabel={t.price.submit}
      invalidMessage={problem ? problemMessage(t, problem, currency) : null}
      onClose={onClose}
      onSubmit={submit}
      successMessage={(data) => grantSuccess(t, data)}
    >
      {partner && <p className="text-sm text-muted-foreground">{t.price.partner}</p>}
      {view.planIncludesSso && <p className="text-sm text-muted-foreground">{t.price.planIncludes}</p>}

      <Field label={t.price.mode}>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as SsoPriceMode)} className="gap-3">
          <Choice value="list" id="sso-price-list" label={t.price.list} hint={listPrice} disabled={partner} />
          <Choice value="custom" id="sso-price-custom" label={t.price.custom} hint={t.price.customHint} disabled={partner} />
          <Choice value="free" id="sso-price-free" label={t.price.free} hint={t.price.freeHint} />
        </RadioGroup>
      </Field>

      {mode === 'custom' && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label={t.price.amount} htmlFor="sso-price-amount">
              <Input
                id="sso-price-amount"
                inputMode="decimal"
                placeholder={t.price.amountPlaceholder}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label={t.price.currency} htmlFor="sso-price-currency">
              <Select value={currency} onValueChange={(v) => setCurrency(v as SsoPriceCurrency)}>
                <SelectTrigger id="sso-price-currency" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SSO_PRICE_CURRENCIES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            {fill(t.price.currencyHint, { currency: view.listPrice.currency.toUpperCase() })}
          </p>
        </div>
      )}

      {live && (
        <p className="text-sm text-muted-foreground">{mode === 'free' ? t.price.liveCancel : t.price.liveReprice}</p>
      )}

      {offerSwitchOn && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            id="sso-price-switch-on"
            checked={switchOn}
            onCheckedChange={(v) => setSwitchOn(v === true)}
            className="mt-0.5"
          />
          <span>
            {t.price.switchOn}
            <span className="block text-xs text-muted-foreground">{t.price.switchOnHint}</span>
          </span>
        </label>
      )}
    </ActionDialog>
  );
}

// ============================================================================
// Revoke
// ============================================================================

export function SsoRevokeDialog({
  workspaceId,
  view,
  onClose,
}: Readonly<{ workspaceId: string; view: SsoAdminView; onClose: () => void }>) {
  const t = ssoCopy();
  const live = liveSsoSubscription(view);
  const freeGrant = view.priceOverride?.unitAmountCents === 0 && !view.planIncludesSso;
  const [mode, setMode] = useState<'period_end' | 'immediately'>('period_end');

  return (
    <ActionDialog
      destructive
      title={t.revoke.title}
      description={t.revoke.description}
      submitLabel={t.revoke.submit}
      onClose={onClose}
      onSubmit={(reason, requestId) => revokeSso(workspaceId, { mode, reason }, requestId)}
      successMessage={(data) => revokeSuccess(t, data)}
    >
      {live ? (
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="gap-3">
          <Choice
            value="period_end"
            id="sso-revoke-period-end"
            label={t.revoke.periodEnd}
            hint={fill(t.revoke.periodEndHint, { date: formatDay(live.currentPeriodEnd) })}
          />
          <Choice value="immediately" id="sso-revoke-immediately" label={t.revoke.immediately} hint={t.revoke.immediatelyHint} />
        </RadioGroup>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t.revoke.noAddon}
          {freeGrant ? ` ${t.revoke.freeGrantEnds}` : ''}
        </p>
      )}
    </ActionDialog>
  );
}

// ============================================================================
// Turn the connection off
// ============================================================================

export function SsoDisableConnectionDialog({
  workspaceId,
  onClose,
}: Readonly<{ workspaceId: string; onClose: () => void }>) {
  const t = ssoCopy();
  return (
    <ActionDialog
      destructive
      title={t.disable.title}
      description={t.disable.description}
      submitLabel={t.disable.submit}
      onClose={onClose}
      onSubmit={(reason, requestId) => disableSsoConnection(workspaceId, { reason }, requestId)}
      successMessage={(data) => (data.wasEnabled ? t.disable.success : t.disable.alreadyOff)}
    />
  );
}
