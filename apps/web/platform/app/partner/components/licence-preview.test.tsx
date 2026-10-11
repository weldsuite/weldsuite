/**
 * The licence editor's live "WeldSuite bills / you keep" figures, against the
 * worked examples in docs/plans/reseller-licensing.md (contract: 75%, $50 base
 * minimum, 2,000 included credits, $0.004 per credit above that).
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { PartnerContractView } from '@weldsuite/app-api-client/schemas/partners';
import { emptyDraft, type LicenceDraft } from '../lib/licence-draft';
import { LicencePreview } from './licence-preview';

const contract: PartnerContractView = {
  id: 'ptc_1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  currency: 'USD',
  revenueShareBps: 7500,
  baseMinimum: '50.00',
  includedCredits: 2000,
  creditFloorPrice: '0.004',
  extraCreditPrice: '0.01',
  allowedFeaturePlanIds: [],
  paymentTermsDays: 30,
  pastDueAfterDays: 14,
  readOnlyAfterDays: 30,
};

function draft(patch: Partial<LicenceDraft>): LicenceDraft {
  return { ...emptyDraft(), ...patch };
}

function renderPreview(d: LicenceDraft, seats = 1, c: PartnerContractView | null = contract) {
  return render(
    <I18nProvider initialLanguage="en">
      <LicencePreview contract={c} draft={d} seats={seats} />
    </I18nProvider>,
  );
}

const figure = (testId: string) => screen.getByTestId(testId).textContent;

describe('LicencePreview', () => {
  it('Acme: flat $400, 2,000 credits. The 75% share ($300) wins over the $50 minimum', () => {
    renderPreview(draft({ monthlyCredits: '2000', pricingModel: 'flat', amount: '400' }));
    expect(figure('preview-resale')).toBe('$400.00');
    expect(figure('preview-share')).toBe('$300.00');
    expect(figure('preview-floor')).toBe('$50.00');
    expect(figure('preview-due')).toBe('$300.00');
    expect(figure('preview-margin')).toBe('$100.00');
    expect(figure('preview-basis')).toMatch(/revenue share applies/i);
  });

  it('Beta: $12 per seat at 5 seats ($60). The minimum applies, partner keeps $10', () => {
    renderPreview(draft({ monthlyCredits: '2000', pricingModel: 'per_seat', amount: '12' }), 5);
    expect(figure('preview-resale')).toBe('$60.00');
    expect(figure('preview-share')).toBe('$45.00');
    expect(figure('preview-due')).toBe('$50.00');
    expect(figure('preview-margin')).toBe('$10.00');
    expect(figure('preview-basis')).toMatch(/minimum applies/i);
  });

  it('Gamma: 20,000 licensed credits raise the minimum to $122', () => {
    renderPreview(draft({ monthlyCredits: '20000', pricingModel: 'flat', amount: '150' }));
    expect(figure('preview-share')).toBe('$112.50');
    expect(figure('preview-floor')).toBe('$122.00');
    // The minimum is shown as its two parts: $50 base + $72 for 18,000 extra credits.
    expect(screen.getByText('$50.00 base + $72.00 for credits')).toBeInTheDocument();
    expect(figure('preview-due')).toBe('$122.00');
    expect(figure('preview-margin')).toBe('$28.00');
  });

  it('Delta: a $0 price is billed at the minimum and the partner pays the difference', () => {
    renderPreview(draft({ monthlyCredits: '2000', pricingModel: 'flat', amount: '0' }));
    expect(figure('preview-due')).toBe('$50.00');
    expect(figure('preview-margin')).toBe('-$50.00');
    expect(figure('preview-basis')).toMatch(/pay the difference/i);
  });

  it('applies the minimum seats billed for per-seat pricing', () => {
    renderPreview(
      draft({ monthlyCredits: '2000', pricingModel: 'per_seat', amount: '20', minSeats: '10' }),
      3,
    );
    // max(3, 10) seats × $20
    expect(figure('preview-resale')).toBe('$200.00');
    expect(figure('preview-due')).toBe('$150.00');
  });

  it('shows no figures, and no NaN, while the amount is half typed', () => {
    renderPreview(draft({ monthlyCredits: '2000', amount: '12.' }));
    expect(screen.queryByTestId('preview-due')).toBeNull();
    expect(screen.getByText(/enter a valid price/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('waits for the contract instead of showing zeros', () => {
    renderPreview(draft({ amount: '100' }), 1, null);
    expect(screen.queryByTestId('preview-due')).toBeNull();
    expect(screen.getByText(/appears once your contract is loaded/i)).toBeInTheDocument();
  });

  it('lets the partner try other seat counts for per-seat pricing', async () => {
    function Harness() {
      const [seats, setSeats] = useState(1);
      return (
        <I18nProvider initialLanguage="en">
          <LicencePreview
            contract={contract}
            draft={draft({ monthlyCredits: '2000', pricingModel: 'per_seat', amount: '25' })}
            seats={seats}
            onSeatsChange={setSeats}
          />
        </I18nProvider>
      );
    }
    render(<Harness />);
    expect(figure('preview-resale')).toBe('$25.00');

    const input = screen.getByLabelText(/billable seats/i);
    await userEvent.clear(input);
    await userEvent.type(input, '8');

    expect(figure('preview-resale')).toBe('$200.00');
    expect(figure('preview-share')).toBe('$150.00');
    expect(within(screen.getByRole('region', { name: /monthly estimate/i })).getByTestId('preview-margin').textContent).toBe(
      '$50.00',
    );
  });
});
