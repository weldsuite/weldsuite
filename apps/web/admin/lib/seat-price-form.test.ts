import { describe, expect, it } from 'vitest';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';
import {
  SEAT_PRICE_ERROR_ID,
  SEAT_PRICE_TOTAL_ID,
  offListNote,
  seatPriceFormState,
  seatPriceProblemMessage,
  seatPriceRefusalMessage,
  type SeatPriceFormInput,
} from './seat-price-form';

const en = mollieBillingCopyByLocale.en;
const nl = mollieBillingCopyByLocale.nl;

describe('offListNote', () => {
  it('says how far a custom price is from the list price', () => {
    expect(offListNote(en, 2000, 2500, 'EUR')).toBe('Custom price, 20% below the list price of €25.00');
    expect(offListNote(en, 2750, 2500, 'EUR')).toBe('Custom price, 10% above the list price of €25.00');
    expect(offListNote(nl, 2000, 2500, 'EUR')).toBe('Aangepaste prijs, 20% onder de lijstprijs van €25.00');
  });

  it('calls a price of zero free seats', () => {
    expect(offListNote(en, 0, 2500, 'EUR')).toBe('Free seats, instead of the list price of €25.00');
    expect(offListNote(nl, 0, 2500, 'EUR')).toBe('Gratis gebruikers, in plaats van de lijstprijs van €25.00');
  });

  it('says nothing at the list price or without one', () => {
    expect(offListNote(en, 2500, 2500, 'EUR')).toBeNull();
    expect(offListNote(en, 2500, null, 'EUR')).toBeNull();
    expect(offListNote(en, null, 2500, 'EUR')).toBeNull();
  });
});

describe('seatPriceProblemMessage', () => {
  it('has a message for every problem', () => {
    expect(seatPriceProblemMessage(en, 'format')).toBe(en.seatPriceDialog.errors.format);
    expect(seatPriceProblemMessage(en, 'too_high')).toBe('A seat can cost at most €10,000.00.');
    expect(seatPriceProblemMessage(en, 'unchanged')).toBe(en.seatPriceDialog.errors.unchanged);
  });
});

describe('seatPriceRefusalMessage', () => {
  it('has a message for every refusal', () => {
    expect(seatPriceRefusalMessage(en, 'not_found', 'EUR')).toBe(en.seatPriceDialog.errors.notFound);
    expect(seatPriceRefusalMessage(en, 'no_subscription', 'EUR')).toBe(en.seatPriceDialog.errors.noSubscription);
    expect(seatPriceRefusalMessage(en, 'not_eur', 'USD')).toBe(
      'This workspace is billed in USD; seat prices are set in EUR only.',
    );
    expect(seatPriceRefusalMessage(en, 'not_eur', null)).toContain('billed in —');
  });
});

describe('seatPriceFormState', () => {
  const input: SeatPriceFormInput = {
    amount: '',
    touched: false,
    current: 2500,
    listPrice: 2500,
    seats: 3,
    interval: 'month',
  };

  it('starts empty: nothing to save, no error, no total', () => {
    expect(seatPriceFormState(en, input)).toEqual({
      cents: null,
      problem: 'format',
      error: null,
      total: null,
      free: false,
      describedBy: undefined,
    });
    // An empty field left behind isn't an error either.
    expect(seatPriceFormState(en, { ...input, touched: true }).error).toBeNull();
  });

  it('totals a price that can be saved, with how far it is from the list price', () => {
    const state = seatPriceFormState(en, { ...input, amount: '19,50' });
    expect(state.cents).toBe(1950);
    expect(state.problem).toBeNull();
    expect(state.total).toBe(
      '3 × €19.50 = €58.50 per month, excl. VAT · Custom price, 22% below the list price of €25.00',
    );
    expect(state.describedBy).toBe(SEAT_PRICE_TOTAL_ID);
    expect(state.free).toBe(false);
  });

  it('saves a price of zero, and says the seats are free', () => {
    const state = seatPriceFormState(en, { ...input, amount: '0', touched: true });
    expect(state.cents).toBe(0);
    expect(state.problem).toBeNull();
    expect(state.error).toBeNull();
    expect(state.free).toBe(true);
    expect(state.total).toBe(
      '3 × €0.00 = €0.00 per month, excl. VAT · Free seats, instead of the list price of €25.00',
    );
    // Zero over seats that are already free is no change, and not free to save.
    const already = seatPriceFormState(en, { ...input, current: 0, amount: '0', touched: true });
    expect(already.error).toBe(en.seatPriceDialog.errors.unchanged);
    expect(already.free).toBe(false);
  });

  it('leaves the note out at the list price', () => {
    const state = seatPriceFormState(en, { ...input, current: 2000, amount: '25' });
    expect(state.total).toBe('3 × €25.00 = €75.00 per month, excl. VAT');
  });

  it('shows a problem only once the field was left', () => {
    const typing = seatPriceFormState(en, { ...input, amount: '25' });
    expect(typing.problem).toBe('unchanged');
    expect(typing.error).toBeNull();
    expect(typing.total).toBeNull();

    const left = seatPriceFormState(en, { ...input, amount: '25', touched: true });
    expect(left.error).toBe(en.seatPriceDialog.errors.unchanged);
    expect(left.describedBy).toBe(SEAT_PRICE_ERROR_ID);

    expect(seatPriceFormState(en, { ...input, amount: '€20', touched: true }).error).toBe(
      en.seatPriceDialog.errors.format,
    );
  });
});
