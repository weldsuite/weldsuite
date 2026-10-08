import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';

vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('./test-utils');
  return { Link: RouteLink };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}` }),
}));

import { DocumentTaxPanel } from './document-tax-panel';
import { SalesTaxErrorNotice, describeSalesTaxError } from './sales-tax-error-notice';
import { previewResult, renderWithProviders } from './test-utils';

function state(overrides: Partial<TaxPreviewState> = {}): TaxPreviewState {
  return { result: previewResult(), isCalculating: false, error: null, errorCode: null, isStale: false, ...overrides };
}

const row = (overrides: Partial<TaxBreakdownRow>): TaxBreakdownRow => ({
  taxRateName: 'Sales tax',
  taxRate: 0,
  taxableAmount: 0,
  taxAmount: 0,
  ...overrides,
});

describe('DocumentTaxPanel', () => {
  it('shows the tax per jurisdiction as the server calculated it', () => {
    renderWithProviders(
      <DocumentTaxPanel
        salesTax
        taxLabel="Sales tax"
        currency="USD"
        state={state({
          result: previewResult({
            taxBreakdown: [
              row({ lineId: 'line_0', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }),
              row({ lineId: 'line_0', jurisdictionCode: 'AUSTIN', jurisdictionName: 'Austin', jurisdictionLevel: 'city', taxRate: 2, taxableAmount: 100, taxAmount: 2 }),
            ],
          }),
        })}
      />,
    );

    const rows = screen.getAllByTestId('tax-breakdown-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/Texas/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('6.25% on $100.00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$6.25')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Austin/)).toBeInTheDocument();
  });

  it('tells the user to add a ship-to address when the address is incomplete', () => {
    renderWithProviders(
      <DocumentTaxPanel salesTax taxLabel="Sales tax" state={state({ result: previewResult({ addressIncomplete: true, taxTotal: '0.00' }) })} />,
    );
    expect(screen.getByTestId('address-needed')).toHaveTextContent(/ship-to state and ZIP code/);
  });

  it('shows the engine warnings as readable messages, naming the state', () => {
    renderWithProviders(
      <DocumentTaxPanel
        salesTax
        taxLabel="Sales tax"
        state={state({ result: previewResult({ warnings: ['not_registered_in_state', 'address_unverified'], shipToState: 'NY', taxTotal: '0.00' }) })}
      />,
    );
    const list = screen.getByTestId('tax-warnings');
    expect(within(list).getByText('No sales tax: you are not registered to collect it in NY.')).toBeInTheDocument();
    expect(within(list).getByText('The address could not be verified, so the state rate was used.')).toBeInTheDocument();
    expect(screen.queryByText('not_registered_in_state')).not.toBeInTheDocument();
  });

  it('shows an inline error with a link to the settings when the engine is unavailable', () => {
    renderWithProviders(
      <DocumentTaxPanel
        salesTax
        taxLabel="Sales tax"
        state={state({
          error: Object.assign(new Error('boom'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 }),
          errorCode: 'TAX_ENGINE_UNAVAILABLE',
          isStale: true,
        })}
      />,
    );

    const notice = screen.getByTestId('engine-unavailable');
    expect(notice).toHaveTextContent('The sales tax engine is not available');
    expect(notice).toHaveTextContent(/cannot be finalized or sent/);
    expect(within(notice).getByRole('link', { name: 'Open sales tax settings' })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/settings',
    );
  });

  it('shows a calculating state without hiding the last values', () => {
    renderWithProviders(
      <DocumentTaxPanel
        salesTax
        taxLabel="Sales tax"
        state={state({
          isCalculating: true,
          isStale: true,
          result: previewResult({
            taxBreakdown: [row({ jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 })],
          }),
        })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Calculating');
    expect(screen.getByTestId('tax-breakdown-row')).toBeInTheDocument();
  });

  it('shows nothing of the US sales tax on a VAT entity', () => {
    renderWithProviders(
      <DocumentTaxPanel
        salesTax={false}
        taxLabel="VAT"
        state={state({ result: previewResult({ engine: null, addressIncomplete: true, warnings: ['not_registered_in_state'] }) })}
      />,
    );
    expect(screen.queryByTestId('address-needed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tax-warnings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tax-breakdown-row')).not.toBeInTheDocument();
  });
});

describe('SalesTaxErrorNotice', () => {
  const refusal = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('refused'), { code, ...extra });

  it('ADDRESS_REQUIRED says what is missing and links to the invoice addresses', () => {
    renderWithProviders(<SalesTaxErrorNotice error={refusal('ADDRESS_REQUIRED', { status: 400 })} invoiceId="inv_1" />);
    const notice = screen.getByTestId('sales-tax-error');
    expect(notice).toHaveTextContent(/ship-to \(or bill-to\) address with a state and ZIP code is needed/);
    expect(within(notice).getByRole('link', { name: 'Edit the invoice addresses' })).toHaveAttribute(
      'href',
      '/weldbooks/invoices/inv_1/edit',
    );
  });

  it('TAX_ENGINE_UNAVAILABLE links to the settings and says to try again when it is retryable', () => {
    renderWithProviders(<SalesTaxErrorNotice error={refusal('TAX_ENGINE_UNAVAILABLE', { status: 503 })} invoiceId="inv_1" />);
    const notice = screen.getByTestId('sales-tax-error');
    expect(notice).toHaveTextContent('Try again in a moment.');
    expect(within(notice).getByRole('link', { name: 'Open sales tax settings' })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/settings',
    );
  });

  it('TAX_RATES_NOT_CONFIGURED links to the agencies', () => {
    renderWithProviders(<SalesTaxErrorNotice error={refusal('TAX_RATES_NOT_CONFIGURED', { status: 400 })} invoiceId="inv_1" />);
    expect(screen.getByRole('link', { name: 'Open sales tax agencies' })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/agencies',
    );
  });

  it('renders nothing for an error that is not a sales tax refusal', () => {
    const { container } = renderWithProviders(<SalesTaxErrorNotice error={new Error('Network down')} invoiceId="inv_1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('describes every refusal code in words', () => {
    const texts = {
      addressRequired: 'a',
      engineUnavailable: 'b',
      engineUnavailableRetry: 'c',
      ratesNotConfigured: 'd',
      useTaxUnsupported: 'e',
      notCalculated: 'f',
      creditLineNotOnOriginal: 'g',
      commitNotApplicable: 'h',
      editAddress: '',
      openSettings: '',
      openAgencies: '',
    };
    expect(describeSalesTaxError(refusal('ADDRESS_REQUIRED'), texts)).toBe('a');
    expect(describeSalesTaxError(refusal('TAX_ENGINE_UNAVAILABLE', { status: 400 }), texts)).toBe('b');
    expect(describeSalesTaxError(refusal('TAX_ENGINE_UNAVAILABLE', { status: 503 }), texts)).toBe('c');
    expect(describeSalesTaxError(refusal('TAX_RATES_NOT_CONFIGURED'), texts)).toBe('d');
    expect(describeSalesTaxError(refusal('CREDIT_LINE_NOT_ON_ORIGINAL'), texts)).toBe('g');
    expect(describeSalesTaxError(refusal('SOMETHING_ELSE'), texts)).toBeNull();
  });
});
