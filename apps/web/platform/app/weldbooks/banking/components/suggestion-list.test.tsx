import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import { confidencePercent, reasonLabel, SuggestionList } from './suggestion-list';
import { renderWithProviders } from './test-utils';

const reasons = en.weldbooksUs.banking.suggestions.reasons;

const suggestions: MatchSuggestion[] = [
  { type: 'invoice', id: 'inv_1', number: 'INV-0042', contactName: 'Acme', amount: '1200.00', confidence: 0.85, reasons: ['exact amount match', 'name matches the customer'] },
  { type: 'payment', id: 'pay_1', number: '1042', contactName: 'Bolt', amount: '300.05', confidence: 0.9, reasons: ['check number matches', 'dates within 30 days'] },
  { type: 'deposit', id: 'dep_1', number: 'January checks', contactName: null, amount: '1550.50', confidence: 0.75, reasons: ['deposit total matches'] },
];

describe('reasonLabel', () => {
  it('translates every reason the matcher writes', () => {
    const written = [
      'exact amount match',
      'close amount match',
      'invoice number in reference',
      'invoice number in end-to-end ID',
      'counterparty IBAN matches contact',
      'counterparty IBAN matches vendor',
      'name matches the customer',
      'name partly matches the customer',
      'name matches the vendor',
      'name partly matches the vendor',
      "name matches the payment's contact",
      "name partly matches the payment's contact",
      'dated before the document',
      'inside the payment window',
      'external reference in description',
      'check number matches',
      'check number matches but the amount differs',
      'dates within 30 days',
      'deposit total matches',
      'deposit dated within a week',
    ];
    for (const reason of written) expect(reasonLabel(reason, reasons)).not.toBe(reason);
    expect(reasonLabel('check number matches', reasons)).toBe('Check number matches');
  });

  it('shows a reason it does not know as written', () => {
    expect(reasonLabel('something new', reasons)).toBe('something new');
  });
});

describe('confidencePercent', () => {
  it('rounds and clamps', () => {
    expect(confidencePercent(0.854)).toBe(85);
    expect(confidencePercent(1.3)).toBe(100);
    expect(confidencePercent(-0.1)).toBe(0);
  });
});

describe('SuggestionList', () => {
  const render = (props: Partial<React.ComponentProps<typeof SuggestionList>> = {}) =>
    renderWithProviders(
      <SuggestionList suggestions={suggestions} formatAmount={(amount) => `$${amount}`} onMatch={props.onMatch ?? vi.fn()} {...props} />,
    );

  it('shows payment and deposit suggestions with their reasons and confidence', () => {
    render();

    const payment = screen.getByTestId('suggestion-payment');
    expect(within(payment).getByText('Payment')).toBeInTheDocument();
    expect(within(payment).getByText('1042')).toBeInTheDocument();
    expect(within(payment).getByText('90% match')).toBeInTheDocument();
    expect(within(payment).getByText('Check number matches')).toBeInTheDocument();
    expect(within(payment).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');

    const deposit = screen.getByTestId('suggestion-deposit');
    expect(within(deposit).getByText('Deposit total matches')).toBeInTheDocument();
    expect(within(deposit).getByText('$1550.50')).toBeInTheDocument();
  });

  it('says that matching a payment or deposit only links it', () => {
    render();
    expect(within(screen.getByTestId('suggestion-payment')).getByText(/Nothing new is posted/)).toBeInTheDocument();
    expect(within(screen.getByTestId('suggestion-deposit')).getByText(/Nothing new is posted/)).toBeInTheDocument();
    expect(within(screen.getByTestId('suggestion-invoice')).queryByText(/Nothing new is posted/)).not.toBeInTheDocument();
  });

  it('reports the suggestion that was matched', async () => {
    const onMatch = vi.fn();
    render({ onMatch });

    await userEvent.setup().click(screen.getByTestId('match-payment'));
    expect(onMatch).toHaveBeenCalledWith(suggestions[1]);
    await userEvent.setup().click(screen.getByTestId('match-deposit'));
    expect(onMatch).toHaveBeenLastCalledWith(suggestions[2]);
    expect(screen.getByTestId('match-payment')).toHaveTextContent('Match payment');
    expect(screen.getByTestId('match-deposit')).toHaveTextContent('Match deposit');
    expect(screen.getByTestId('match-invoice')).toHaveTextContent('Record payment and reconcile');
  });

  it('disables matching while a match is running or without permission', () => {
    render({ readOnly: true });
    expect(screen.getByTestId('match-payment')).toBeDisabled();
  });
});
