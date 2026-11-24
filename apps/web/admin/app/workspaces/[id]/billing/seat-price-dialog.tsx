'use client';

import { useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { setSeatPrice } from '@/actions/seat-price';
import type { ActionResult } from '@/actions/workspaces';
import { formatCents, formatDay } from '@/lib/billing-format';
import type { MollieBillingAccount, WorkspaceBilling } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import { mollieBillingCopy, type MollieBillingCopy } from '@/lib/mollie-billing-copy';
import {
  MAX_SEAT_PRICE_CENTS,
  SEAT_PRICE_CURRENCY,
  formatOffList,
  offList,
  typedSeatPriceProblem,
  type SeatPriceProblem,
} from '@/lib/seat-price';
import { centsToMajorUnits, parseMajorUnitsToCents } from '@/lib/sso-admin';

function problemMessage(c: MollieBillingCopy, problem: SeatPriceProblem): string {
  const e = c.seatPriceDialog.errors;
  switch (problem) {
    case 'format':
      return e.format;
    case 'zero':
      return e.zero;
    case 'too_high':
      return fill(e.tooHigh, { max: formatCents(MAX_SEAT_PRICE_CENTS, SEAT_PRICE_CURRENCY) });
    case 'unchanged':
      return e.unchanged;
  }
}

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
  const money = (cents: number | null) => formatCents(cents, SEAT_PRICE_CURRENCY);
  const perSeat = (cents: number | null) => fill(d.perSeat, { amount: money(cents), interval });

  const input = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
  // The field's error shows once it has been left (or a save was tried), not while typing.
  const [touched, setTouched] = useState(false);

  const cents = parseMajorUnitsToCents(amount);
  const problem = typedSeatPriceProblem(amount, account.unitAmount);
  const shownProblem = touched && amount.trim() !== '' ? problem : null;
  const off = problem ? null : offList(cents, listPrice);
  const scheduledChange = Boolean(account.scheduled?.planId || account.scheduled?.cycle);

  const submit = (reason: string): Promise<ActionResult<{ unitAmount: number; previous: number }>> => {
    if (problem || cents === null) {
      setTouched(true);
      input.current?.focus();
      return Promise.resolve({ ok: false, error: problemMessage(c, problem ?? 'format') });
    }
    return setSeatPrice({ workspaceId, unitAmount: cents, reason });
  };

  const total =
    cents !== null && !problem
      ? [
          fill(d.total, {
            seats: billing.purchasedSeats,
            amount: money(cents),
            total: money(cents * billing.purchasedSeats),
            interval,
          }),
          off === null
            ? null
            : fill(off > 0 ? c.seatPriceNote.below : c.seatPriceNote.above, {
                percent: formatOffList(off),
                list: money(listPrice),
              }),
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const describedBy = [total ? 'seat-price-total' : null, shownProblem ? 'seat-price-error' : null].filter(Boolean);

  // The field shows its own error, so the dialog's footer message stays unset;
  // a save with a bad amount is refused in `submit`, which focuses the field.
  return (
    <ActionDialog
      title={d.title}
      description={fill(d.description, { plan: planName })}
      submitLabel={d.submit}
      onClose={onClose}
      onSubmit={(reason) => submit(reason)}
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
            aria-invalid={shownProblem !== null}
            aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
          />
          {listPrice !== null && listPrice !== account.unitAmount && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAmount(centsToMajorUnits(listPrice))}>
              {d.useList}
            </Button>
          )}
        </div>
        {total && (
          <p id="seat-price-total" className="text-xs text-muted-foreground">
            {total}
          </p>
        )}
        {shownProblem && (
          <p id="seat-price-error" className="text-xs text-destructive">
            {problemMessage(c, shownProblem)}
          </p>
        )}
      </Field>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {/* The plan is charged when its period ends; a yearly plan's next charge is only the month's add-ons. */}
        <p>{fill(d.when, { date: formatDay(billing.currentPeriodEnd) })}</p>
        <p>{d.ends}</p>
        {scheduledChange && (
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {fill(d.scheduled, { date: formatDay(billing.currentPeriodEnd) })}
          </p>
        )}
      </div>
    </ActionDialog>
  );
}
