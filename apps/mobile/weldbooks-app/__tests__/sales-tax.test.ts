import {
  apiErrorCode,
  chargedTaxTotal,
  describeApiError,
  exemptReasonsOf,
  groupTaxBreakdown,
  hasExemptRows,
  isRetryableTaxError,
  parseTaxWarning,
  salesTaxErrorCode,
  taxWarningText,
  accruedUseTaxTotal,
} from '@/lib/sales-tax';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import type { TaxBreakdownRow } from '@/types/accounting';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, NetworkError } = require('@weldsuite/api-client/client') as {
  ApiError: new (message: string, status: number, body?: unknown) => Error;
  NetworkError: new (message?: string) => Error;
};

/** An error the way the client throws one: the message from `error.message`, the whole body kept. */
function refusal(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return new ApiError(message, status, { error: { code, message, details } });
}

const rows: TaxBreakdownRow[] = [
  // Two lines in the same state: one jurisdiction on the document.
  { lineId: 'l1', jurisdictionCode: '48', jurisdictionName: 'Texas', jurisdictionLevel: 'state', stateCode: 'TX', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 },
  { lineId: 'l2', jurisdictionCode: '48', jurisdictionName: 'Texas', jurisdictionLevel: 'state', stateCode: 'TX', taxRate: 6.25, taxableAmount: 50, taxAmount: 3.13 },
  { lineId: 'l1', jurisdictionCode: '48-AUSTIN', jurisdictionName: 'Austin', jurisdictionLevel: 'city', stateCode: 'TX', taxRate: 1, taxableAmount: 100, taxAmount: 1 },
  { lineId: 'l1', jurisdictionCode: '48-TRAVIS', jurisdictionName: 'Travis County', jurisdictionLevel: 'county', stateCode: 'TX', taxRate: 0.5, taxableAmount: 100, taxAmount: 0.5 },
  { lineId: 'l1', jurisdictionCode: '48-D1', jurisdictionName: 'Capital Metro', jurisdictionLevel: 'district', stateCode: 'TX', taxRate: 1, taxableAmount: 100, taxAmount: 1 },
];

describe('groupTaxBreakdown', () => {
  it('sums the lines of one jurisdiction', () => {
    const groups = groupTaxBreakdown(rows);
    const texas = groups.find((group) => group.name === 'Texas');

    expect(texas).toMatchObject({ level: 'state', stateCode: 'TX', rate: 6.25, taxableAmount: 150, taxAmount: 9.38 });
  });

  it('lists state first, then county, city and district', () => {
    expect(groupTaxBreakdown(rows).map((group) => group.level)).toEqual(['state', 'county', 'city', 'district']);
  });

  it('keeps two rates of one state apart (food and general goods are taxed differently)', () => {
    const groups = groupTaxBreakdown([
      { jurisdictionCode: '06', jurisdictionName: 'California', jurisdictionLevel: 'state', taxRate: 7.25, taxableAmount: 100, taxAmount: 7.25 },
      { jurisdictionCode: '06', jurisdictionName: 'California', jurisdictionLevel: 'state', taxRate: 0, taxableAmount: 40, taxAmount: 0 },
    ]);

    expect(groups).toHaveLength(2);
  });

  it('reads the amounts the API sends as strings', () => {
    const [group] = groupTaxBreakdown([
      { jurisdictionName: 'Ohio', jurisdictionLevel: 'state', taxRate: '5.75', taxableAmount: '200.00', taxAmount: '11.50' },
    ]);

    expect(group).toMatchObject({ rate: 5.75, taxableAmount: 200, taxAmount: 11.5 });
  });

  it('puts use tax after the tax charged and keeps it apart', () => {
    const groups = groupTaxBreakdown([
      { jurisdictionName: 'Washington', jurisdictionLevel: 'state', kind: 'use', taxRate: 6.5, taxableAmount: 1000, taxAmount: 65 },
      { jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 },
    ]);

    expect(groups.map((group) => [group.name, group.kind])).toEqual([
      ['Texas', 'tax'],
      ['Washington', 'use'],
    ]);
  });

  it('shows a VAT row under its rate name', () => {
    const [group] = groupTaxBreakdown([{ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 }]);

    expect(group).toMatchObject({ name: 'BTW 21%', level: null, rate: 21, taxAmount: 21 });
  });

  it('copes with nothing', () => {
    expect(groupTaxBreakdown(null)).toEqual([]);
    expect(groupTaxBreakdown(undefined)).toEqual([]);
    expect(groupTaxBreakdown([])).toEqual([]);
  });
});

describe('totals of a breakdown', () => {
  it('adds the tax charged and leaves out use tax', () => {
    const mixed: TaxBreakdownRow[] = [
      { taxAmount: 6.25 },
      { taxAmount: 1.5 },
      { taxAmount: 65, kind: 'use' },
    ];

    expect(chargedTaxTotal(mixed)).toBe(7.75);
    expect(accruedUseTaxTotal(mixed)).toBe(65);
  });

  it('rounds to the cent', () => {
    expect(chargedTaxTotal([{ taxAmount: 0.1 }, { taxAmount: 0.2 }])).toBe(0.3);
  });
});

describe('exempt sales', () => {
  const exemptRows: TaxBreakdownRow[] = [
    { jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 0, taxAmount: 0, exemptAmount: 500, exemptReason: 'resale', certificateId: 'cert_1' },
    { jurisdictionName: 'Austin', jurisdictionLevel: 'city', taxRate: 1, taxableAmount: 0, taxAmount: 0, exemptAmount: 500, exemptReason: 'resale' },
  ];

  it('spots a sale that is exempt in part or whole', () => {
    expect(hasExemptRows(exemptRows)).toBe(true);
    expect(hasExemptRows([{ taxAmount: 5, exemptAmount: 0 }])).toBe(false);
    expect(hasExemptRows([{ taxAmount: 0, exemptReason: 'nonprofit' }])).toBe(true);
    expect(hasExemptRows(undefined)).toBe(false);
  });

  it('lists each reason once', () => {
    expect(exemptReasonsOf(exemptRows)).toEqual(['resale']);
    expect(exemptReasonsOf([{ exemptReason: 'resale' }, { exemptReason: 'government' }, { exemptReason: 'resale' }])).toEqual([
      'resale',
      'government',
    ]);
  });

  it('keeps the reasons on the jurisdiction groups', () => {
    const [state] = groupTaxBreakdown(exemptRows);

    expect(state).toMatchObject({ exemptAmount: 500, exemptReasons: ['resale'] });
  });
});

describe('warnings', () => {
  it('splits a code from the detail the server appends', () => {
    expect(parseTaxWarning('not_registered_in_state')).toEqual({ code: 'not_registered_in_state', detail: null });
    expect(parseTaxWarning('tax_engine_unavailable: the provider timed out')).toEqual({
      code: 'tax_engine_unavailable',
      detail: 'the provider timed out',
    });
  });

  it('puts the engine warnings in words', () => {
    expect(taxWarningText('not_registered_in_state', en.salesTax.warnings)).toMatch(/not registered/i);
    expect(taxWarningText('address_unverified', en.salesTax.warnings)).toMatch(/could not be verified/i);
    expect(taxWarningText('no_ship_to', en.salesTax.warnings)).toMatch(/billing address was used/i);
    expect(taxWarningText('tax_engine_unavailable: timeout', en.salesTax.warnings)).toMatch(/can't be finalised/i);
  });

  it('puts them in Dutch too', () => {
    expect(taxWarningText('not_registered_in_state', nl.salesTax.warnings)).toMatch(/niet geregistreerd/i);
  });

  it('shows an unknown warning as readable text instead of dropping it', () => {
    expect(taxWarningText('brand_new_warning', en.salesTax.warnings)).toBe('brand new warning');
    expect(taxWarningText('brand_new_warning: with detail', en.salesTax.warnings)).toBe('brand new warning: with detail');
  });

  it('has text for every warning code books-api can raise', () => {
    const codes = [
      'not_registered_in_state',
      'address_unverified',
      'no_ship_to',
      'certificate_expired',
      'certificate_missing',
      'marketplace_facilitated',
      'zone_not_found',
      'no_use_tax_registration',
      'rates_not_configured',
      'override_not_applied',
      'provider_rate_date_ignored',
      'provider_not_supported',
      'provider_nexus_missing',
      'tax_engine_unavailable',
      'commit_failed',
      'reverse_failed',
      'reverse_unsupported',
      'reverse_skipped',
    ];
    for (const catalog of [en.salesTax.warnings, nl.salesTax.warnings]) {
      for (const code of codes) expect((catalog as Record<string, string>)[code]).toBeTruthy();
    }
  });
});

describe('sales tax refusals', () => {
  it('reads the code out of the error body', () => {
    expect(apiErrorCode(refusal(400, 'ADDRESS_REQUIRED', 'x'))).toBe('ADDRESS_REQUIRED');
    expect(apiErrorCode(new Error('plain'))).toBeNull();
    expect(apiErrorCode(new ApiError('no body', 500))).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
  });

  it('knows the sales tax codes and no others', () => {
    expect(salesTaxErrorCode(refusal(400, 'ADDRESS_REQUIRED', 'x'))).toBe('ADDRESS_REQUIRED');
    expect(salesTaxErrorCode(refusal(503, 'TAX_ENGINE_UNAVAILABLE', 'x'))).toBe('TAX_ENGINE_UNAVAILABLE');
    expect(salesTaxErrorCode(refusal(400, 'BAD_REQUEST', 'x'))).toBeNull();
  });

  it('answers ADDRESS_REQUIRED with a message that says what to do, not the server text', () => {
    const err = refusal(
      400,
      'ADDRESS_REQUIRED',
      'A ship-to (or bill-to) address with a state and ZIP code is required to calculate sales tax. Add it to the invoice before finalizing.',
    );

    const message = describeApiError(err, en, en.common.actionFailed);

    expect(message).toBe(en.salesTax.errors.addressRequired);
    expect(message).toMatch(/ship-to/i);
    expect(message).toMatch(/ZIP/);
    expect(describeApiError(err, nl, nl.common.actionFailed)).toBe(nl.salesTax.errors.addressRequired);
  });

  it('answers an unreachable tax engine with a retry hint and a failing one without', () => {
    const down = refusal(503, 'TAX_ENGINE_UNAVAILABLE', 'engine down', { engineCode: 'unreachable', retryable: true });
    const broken = refusal(400, 'TAX_ENGINE_UNAVAILABLE', 'bad credentials', { engineCode: 'auth', retryable: false });

    expect(isRetryableTaxError(down)).toBe(true);
    expect(isRetryableTaxError(broken)).toBe(false);
    expect(describeApiError(down, en, 'fallback')).toBe(en.salesTax.errors.engineUnavailableRetry);
    expect(describeApiError(broken, en, 'fallback')).toBe(en.salesTax.errors.engineUnavailable);
    expect(en.salesTax.errors.engineUnavailableRetry).toMatch(/try again/i);
  });

  it('treats a 503 from the engine as retryable even without details', () => {
    expect(isRetryableTaxError(refusal(503, 'TAX_ENGINE_UNAVAILABLE', 'x'))).toBe(true);
    expect(isRetryableTaxError(refusal(400, 'ADDRESS_REQUIRED', 'x'))).toBe(false);
  });

  it('answers the other sales tax refusals', () => {
    expect(describeApiError(refusal(400, 'TAX_RATES_NOT_CONFIGURED', 'x'), en, 'f')).toBe(en.salesTax.errors.ratesNotConfigured);
    expect(describeApiError(refusal(400, 'USE_TAX_ENGINE_UNSUPPORTED', 'x'), en, 'f')).toBe(en.salesTax.errors.useTaxUnsupported);
    expect(describeApiError(refusal(409, 'TAX_NOT_CALCULATED', 'x'), en, 'f')).toBe(en.salesTax.errors.notCalculated);
    expect(describeApiError(refusal(400, 'CREDIT_LINE_NOT_ON_ORIGINAL', 'x'), en, 'f')).toBe(
      en.salesTax.errors.creditLineNotOnOriginal,
    );
    expect(describeApiError(refusal(400, 'TAX_COMMIT_NOT_APPLICABLE', 'x'), en, 'f')).toBe(en.salesTax.errors.commitNotApplicable);
  });

  it('says so when the device is offline', () => {
    expect(describeApiError(new NetworkError(), en, 'fallback')).toBe(en.common.offlineError);
    expect(describeApiError(new NetworkError(), nl, 'fallback')).toBe(nl.common.offlineError);
  });

  it('passes on the server text of any other refusal', () => {
    expect(describeApiError(refusal(400, 'BAD_REQUEST', 'The period is locked'), en, 'fallback')).toBe('The period is locked');
    expect(describeApiError(new Error('boom'), en, 'fallback')).toBe('boom');
  });

  it('falls back when there is nothing to say', () => {
    expect(describeApiError({}, en, 'fallback')).toBe('fallback');
    expect(describeApiError(undefined, en, 'fallback')).toBe('fallback');
    expect(describeApiError(new Error(''), en, 'fallback')).toBe('fallback');
  });
});
