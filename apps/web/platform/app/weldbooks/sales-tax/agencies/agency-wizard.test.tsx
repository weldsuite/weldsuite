import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AgencyWizard } from './agency-wizard';
import { installPointerPolyfills, makeAgency, renderWithProviders } from '../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;

function routes(agencies: unknown[] = []) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/sales-tax-agencies')) return { data: agencies };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  routes();
  api.post.mockResolvedValue({ data: { ...makeAgency({ id: 'sta_9' }), accountsCreated: 2, rulesSeeded: 2 } });
});

describe('AgencyWizard', () => {
  it('starts on the state step when no state is given, and ignores one that has no sales tax', () => {
    renderWithProviders(<AgencyWizard initialStateCode="OR" />);
    expect(screen.getByText(setup.wizard.stateStep.pickState)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('jumps to the registration step for a state from the nexus monitor and explains the state', () => {
    renderWithProviders(<AgencyWizard initialStateCode="tx" />);
    expect(screen.getByLabelText('Registered from')).toBeInTheDocument();
    const panel = screen.getByTestId('state-info-panel');
    expect(panel).toHaveTextContent('Texas at a glance');
    expect(panel).toHaveTextContent('Texas Comptroller of Public Accounts');
    // Texas sources intrastate sales at the seller, so the panel says to charge the rate at your own location.
    expect(screen.getByTestId('state-sourcing')).toHaveTextContent('origin-sourced');
  });

  it('refuses to register without the date the registration starts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyWizard initialStateCode="TX" />);

    await user.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText(setup.validation.registeredFromRequired)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('registers with the state defaults and the typed date, then opens the agency', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyWizard initialStateCode="TX" />);

    fireEvent.change(screen.getByLabelText('Registered from'), { target: { value: '2026-01-01' } });
    await user.type(screen.getByLabelText('Registration or permit number'), '32-1234567');
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax-agencies', {
      stateCode: 'TX',
      level: 'state',
      status: 'registered',
      filingFrequency: 'quarterly',
      dueDay: 20,
      reportingBasis: 'accrual',
      sstMember: false,
      registrationNumber: '32-1234567',
      registeredFrom: '2026-01-01',
      portalUrl: 'https://comptroller.texas.gov/taxes/sales',
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/agencies/$id', params: { id: 'sta_9' } }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Registered in Texas',
      expect.objectContaining({ description: '2 payable accounts created. 2 shipping rules added from the state\'s usual treatment.' }),
    );
  });

  it('does not offer the cash basis in a state that requires accrual', () => {
    renderWithProviders(<AgencyWizard initialStateCode="TX" />);
    expect(screen.getByTestId('accrual-only-note')).toHaveTextContent('Texas requires the accrual basis');
    expect(screen.queryByRole('radio', { name: 'Cash' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Accrual' })).not.toBeInTheDocument();
  });

  it('offers the cash basis where the state allows it, and sends the choice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyWizard initialStateCode="WA" />);

    expect(screen.queryByTestId('accrual-only-note')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Registered from'), { target: { value: '2026-02-01' } });
    await user.click(screen.getByRole('radio', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({
      stateCode: 'WA',
      reportingBasis: 'cash',
      dueDay: 25,
      sstMember: true,
      registeredFrom: '2026-02-01',
    });
  });

  it('registers a state you are only monitoring without a start date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyWizard initialStateCode="CA" />);

    await user.click(screen.getByRole('radio', { name: /Monitoring/ }));
    expect(screen.queryByLabelText('Registered from')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const payload = api.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({ stateCode: 'CA', status: 'monitoring', dueDay: 31 });
    expect(payload).not.toHaveProperty('registeredFrom');
  });

  it('shows the server sentence when the registration is refused', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('This entity already has a Texas agency. Edit it instead of adding another.'));
    renderWithProviders(<AgencyWizard initialStateCode="TX" />);

    fireEvent.change(screen.getByLabelText('Registered from'), { target: { value: '2026-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText(/already has a Texas agency/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('will not add a second agency for a state that has one', async () => {
    const user = userEvent.setup();
    routes([makeAgency({ stateCode: 'TX', status: 'closed' })]);
    renderWithProviders(<AgencyWizard initialStateCode="TX" />);

    await user.click(screen.getAllByRole('button', { name: 'Back' })[0]);

    expect(await screen.findByText(setup.wizard.duplicate)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
