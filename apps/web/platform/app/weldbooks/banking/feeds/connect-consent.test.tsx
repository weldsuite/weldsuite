import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { ConnectConsent } from './connect-bank-dialog';
import { renderWithProviders } from './test-support';

describe('ConnectConsent', () => {
  it('names Plaid and links both privacy policies, opening in a new tab', () => {
    renderWithProviders(<ConnectConsent providerId="plaid" />);

    expect(
      screen.getByText(/By continuing, you agree that WeldSuite and Plaid access your bank account and transaction data/),
    ).toBeInTheDocument();
    const weldsuite = screen.getByRole('link', { name: 'WeldSuite Privacy Policy' });
    expect(weldsuite).toHaveAttribute('href', 'https://www.weldsuite.org/privacy');
    expect(weldsuite).toHaveAttribute('target', '_blank');
    expect(weldsuite).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Plaid End User Privacy Policy' })).toHaveAttribute(
      'href',
      'https://plaid.com/legal/#end-user-privacy-policy',
    );
  });

  it('links only our policy for a provider without one to link', () => {
    renderWithProviders(<ConnectConsent providerId="ponto" />);

    expect(screen.getByRole('link', { name: 'WeldSuite Privacy Policy' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText(/\{providerPolicy\}/)).not.toBeInTheDocument();
  });
});
