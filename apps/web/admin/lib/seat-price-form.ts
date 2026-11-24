// Client-safe text for a workspace's seat price on Mollie: the card's note,
// the dialog's state, and the messages the dialog and the server write
// (actions/seat-price.server.ts) give. The rules are in ./seat-price.ts.

import { formatCents } from './billing-format';
import { fill } from './i18n';
import type { MollieBillingCopy } from './mollie-billing-copy';
import {
  MAX_SEAT_PRICE_CENTS,
  SEAT_PRICE_CURRENCY,
  formatOffList,
  offList,
  typedSeatPriceProblem,
  type SeatPriceProblem,
  type SeatPriceRefusal,
} from './seat-price';
import { parseMajorUnitsToCents } from './sso-admin';

/** "Custom price, 20% below the list price of €25.00", or null at the list price or without one. */
export function offListNote(
  copy: MollieBillingCopy,
  unit: number | null,
  list: number | null,
  currency: string,
): string | null {
  const off = offList(unit, list);
  if (off === null) return null;
  const template = off > 0 ? copy.seatPriceNote.below : copy.seatPriceNote.above;
  return fill(template, { percent: formatOffList(off), list: formatCents(list, currency) });
}

/** What to tell staff about a price that can't be saved. */
export function seatPriceProblemMessage(copy: MollieBillingCopy, problem: SeatPriceProblem): string {
  const e = copy.seatPriceDialog.errors;
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

/** What to tell staff about a workspace whose seat price can't be set. */
export function seatPriceRefusalMessage(
  copy: MollieBillingCopy,
  refusal: SeatPriceRefusal,
  currency: string | null | undefined,
): string {
  const e = copy.seatPriceDialog.errors;
  switch (refusal) {
    case 'not_found':
      return e.notFound;
    case 'no_subscription':
      return e.noSubscription;
    case 'not_eur':
      return fill(e.notEur, { currency: currency ?? '—' });
  }
}

export interface SeatPriceFormInput {
  /** What was typed: "20", "19.50", "19,5". */
  amount: string;
  /** Whether the field was left (or a save tried) since it was typed in. */
  touched: boolean;
  /** The seat price the workspace pays now, in cents. */
  current: number | null;
  listPrice: number | null;
  seats: number;
  /** "month" or "year", as the copy says it. */
  interval: string;
}

export interface SeatPriceFormState {
  /** The typed price in cents, when it reads as one. */
  cents: number | null;
  /** Why it can't be saved (an empty field is `format`); null when it can. */
  problem: SeatPriceProblem | null;
  /** The field's error: only once it was left with something in it. */
  error: string | null;
  /** "3 × €19.50 = €58.50 per month, excl. VAT · Custom price, 22% below …", for a price that can be saved. */
  total: string | null;
  /** The field's `aria-describedby`: the total and the error while they show. */
  describedBy: string | undefined;
}

export const SEAT_PRICE_TOTAL_ID = 'seat-price-total';
export const SEAT_PRICE_ERROR_ID = 'seat-price-error';

/** The seat price dialog's state for what was typed. */
export function seatPriceFormState(copy: MollieBillingCopy, input: SeatPriceFormInput): SeatPriceFormState {
  const cents = parseMajorUnitsToCents(input.amount);
  const problem = typedSeatPriceProblem(input.amount, input.current);
  const shown = input.touched && input.amount.trim() !== '' ? problem : null;
  const error = shown ? seatPriceProblemMessage(copy, shown) : null;

  let total: string | null = null;
  if (cents !== null && problem === null) {
    const money = (value: number | null) => formatCents(value, SEAT_PRICE_CURRENCY);
    const line = fill(copy.seatPriceDialog.total, {
      seats: input.seats,
      amount: money(cents),
      total: money(cents * input.seats),
      interval: input.interval,
    });
    const note = offListNote(copy, cents, input.listPrice, SEAT_PRICE_CURRENCY);
    total = note ? `${line} · ${note}` : line;
  }

  const ids = [total ? SEAT_PRICE_TOTAL_ID : null, error ? SEAT_PRICE_ERROR_ID : null].filter(Boolean);
  return { cents, problem, error, total, describedBy: ids.length > 0 ? ids.join(' ') : undefined };
}
