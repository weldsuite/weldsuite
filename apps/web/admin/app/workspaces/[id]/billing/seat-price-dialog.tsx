'use client';

import { useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { setSeatPrice } from '@/actions/seat-price';
import type { ActionResult } from '@/actions/workspaces';
import { centsToMajorUnits, formatCents, formatDay } from '@/lib/billing-format';
import type { MollieBillingAccount, WorkspaceBilling } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import { mollieBillingCopy } from '@/lib/mollie-billing-copy';
import { SEAT_PRICE_CURRENCY } from '@/lib/seat-price';
import {
  SEAT_PRICE_ERROR_ID,
  SEAT_PRICE_TOTAL_ID,
  seatPriceFormState,
  seatPriceProblemMessage,
} from '@/lib/seat-price-form';

/**
 * Sets what a workspace paying through Mollie is charged per seat, in place
 * of its plan's list price (actions/seat-price.server.ts). Mount it only
 * while open.
 */
export function SeatPriceDialog({
  workspaceId,
  account,
  billing,
  planName,
  listPrice,
  onClose,
}: Readonly<{
  workspaceId: string;
  account: MollieBillingAccount;
  billing: WorkspaceBilling;
  planName: string;
  /** The plan's price per seat for the workspace's cycle, in cents; null when it has none. */
  listPrice: number | null;
  onClose: () => void;
}>) {
  const c = mollieBillingCopy();
  const d = c.seatPriceDialog;
  const interval = billing.subscriptionCycle === 'yearly' ? c.intervalYear : c.intervalMonth;
  const perSeat = (cents: number | null) =>
    fill(d.perSeat, { amount: formatCents(cents, SEAT_PRICE_CURRENCY), interval });

  const input = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
  // The field's error shows once it has been left (or a save was tried), not while typing.
  const [touched, setTouched] = useState(false);
  const form = seatPriceFormState(c, {
    amount,
    touched,
    current: account.unitAmount,
    listPrice,
    seats: billing.purchasedSeats,
    interval,
  });
  const scheduledChange = Boolean(account.scheduled?.planId || account.scheduled?.cycle);

  // The field shows its own error, so the dialog's footer message stays unset;
  // a save with a bad amount is refused here, which focuses the field.
  const submit = (reason: string): Promise<ActionResult<{ unitAmount: number; previous: number }>> => {
    if (form.problem || form.cents === null) {
      setTouched(true);
      input.current?.focus();
      return Promise.resolve({ ok: false, error: seatPriceProblemMessage(c, form.problem ?? 'format') });
    }
    return setSeatPrice({ workspaceId, unitAmount: form.cents, reason });
  };

  return (
    <ActionDialog
      title={d.title}
      description={fill(d.description, { plan: planName })}
      submitLabel={d.submit}
      onClose={onClose}
      onSubmit={submit}
      successMessage={d.success}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{d.current}</dt>
        <dd className="text-right">{perSeat(account.unitAmount)}</dd>
        <dt className="text-muted-foreground">{d.listPrice}</dt>
        <dd className="text-right">{listPrice === null ? c.none : perSeat(listPrice)}</dd>
      </dl>

      <Field label={fill(d.amount, { interval })} htmlFor="seat-price-amount">
        <div className="flex items-center gap-2">
          <Input
            ref={input}
            id="seat-price-amount"
            name="unitAmount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            required
            placeholder={d.amountPlaceholder}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => setTouched(amount.trim() !== '')}
            aria-invalid={form.error !== null}
            aria-describedby={form.describedBy}
          />
          {listPrice !== null && listPrice !== account.unitAmount && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAmount(centsToMajorUnits(listPrice))}>
              {d.useList}
            </Button>
          )}
        </div>
        {form.total && (
          <p id={SEAT_PRICE_TOTAL_ID} className="text-xs text-muted-foreground">
            {form.total}
          </p>
        )}
        {form.error && (
          <p id={SEAT_PRICE_ERROR_ID} className="text-xs text-destructive">
            {form.error}
          </p>
        )}
      </Field>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {/* The plan is charged when its period ends; a yearly plan's next charge is only the month's add-ons. */}
        <p>{fill(d.when, { date: formatDay(billing.currentPeriodEnd) })}</p>
        <p>{d.ends}</p>
        {form.free && <p className="font-medium text-foreground">{d.free}</p>}
        {scheduledChange && (
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {fill(d.scheduled, { date: formatDay(billing.currentPeriodEnd) })}
          </p>
        )}
      </div>
    </ActionDialog>
  );
}
