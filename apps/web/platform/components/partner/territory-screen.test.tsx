/**
 * "WeldSuite in {country} is provided by {partner}": the screen a person gets
 * instead of a new workspace when a partner serves their country.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import type { PartnerTerritoryErrorDetails } from '@weldsuite/app-api-client/schemas/partners';
import { TerritoryScreen } from './territory-screen';

const mocks = vi.hoisted(() => ({ submit: vi.fn() }));

vi.mock('@/hooks/queries/use-partner-queries', () => ({
  useSubmitPartnerRequest: () => ({ mutateAsync: mocks.submit, isPending: false }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'jane@customer.example' } } }),
}));

const details: PartnerTerritoryErrorDetails = {
  country: 'BR',
  partner: {
    id: 'ptr_1',
    name: 'Acme Partner',
    logoUrl: null,
    websiteUrl: 'https://partner.example',
    supportEmail: 'help@partner.example',
    // A javascript: URL passes a basic URL check; it must never become a link.
    supportUrl: 'javascript:alert(1)',
  },
};

function renderScreen(props: Partial<React.ComponentProps<typeof TerritoryScreen>> = {}) {
  const onClose = vi.fn();
  const onBack = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <TerritoryScreen details={details} defaultCompany="Acme Industries" selectedApps={['crm', 'mail']} onBack={onBack} onClose={onClose} {...props} />
    </I18nProvider>,
  );
  return { onClose, onBack };
}

describe('TerritoryScreen', () => {
  beforeEach(() => {
    mocks.submit.mockReset();
  });

  it('names the country and the partner, with their contact details', () => {
    renderScreen();
    expect(screen.getByRole('heading', { name: 'WeldSuite in Brazil is provided by Acme Partner' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /website/i })).toHaveAttribute('href', 'https://partner.example/');
    expect(screen.getByRole('link', { name: 'help@partner.example' })).toHaveAttribute(
      'href',
      'mailto:help@partner.example',
    );
  });

  it('renders no link for an unsafe support URL', () => {
    renderScreen();
    expect(screen.queryByRole('link', { name: /support page/i })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('sends the request with the company, country, chosen apps and message', async () => {
    mocks.submit.mockResolvedValue({ data: { id: 'pwr_1' } });
    renderScreen();

    await userEvent.type(screen.getByLabelText(/message/i), 'We need a helpdesk');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith({
        companyName: 'Acme Industries',
        country: 'BR',
        selectedApps: ['crm', 'mail'],
        message: 'We need a helpdesk',
      }),
    );
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
    expect(screen.getByText(/jane@customer.example/)).toBeInTheDocument();
  });

  it('needs a company name before it sends anything', async () => {
    renderScreen({ defaultCompany: '' });
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('keeps the form and says so when the request fails', async () => {
    mocks.submit.mockRejectedValue(new ApiError('boom', 500, {}));
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send your request/i);
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  it('shows the daily request limit message from the server', async () => {
    mocks.submit.mockRejectedValue(
      new ApiError('You already sent several requests today', 429, {
        error: { code: 'RATE_LIMITED', message: 'You already sent several requests today' },
      }),
    );
    renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already sent several requests today');
  });

  it('goes back to the form it came from', async () => {
    const { onBack } = renderScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('speaks Dutch when the locale is nl', async () => {
    render(
      <I18nProvider initialLanguage="nl">
        <TerritoryScreen details={details} onClose={() => {}} />
      </I18nProvider>,
    );
    // The nl bundle loads lazily; the English fallback is shown until it lands.
    expect(
      await screen.findByRole('heading', { name: /wordt geleverd door Acme Partner/ }, { timeout: 15000 }),
    ).toBeInTheDocument();
  });
});
