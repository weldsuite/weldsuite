import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AgencyStatusMenu } from './agency-status-menu';
import { installPointerPolyfills, makeAgency, renderWithProviders } from '../setup/test-support';

const ta = en.weldbooksUs.salesTax.setup.agency;

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.patch.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.patch.mockResolvedValue({ data: makeAgency() });
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: new RegExp(ta.changeStatus) }));
}

describe('AgencyStatusMenu', () => {
  it('offers every status but the current one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'registered' })} />);
    await openMenu(user);

    expect(await screen.findByRole('menuitem', { name: ta.statusActions.pending })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: ta.statusActions.monitoring })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: ta.statusActions.closed })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: ta.statusActions.registered })).not.toBeInTheDocument();
  });

  it('asks for the date the registration starts before marking an agency registered', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'pending', registeredFrom: null })} />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: ta.statusActions.registered }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(ta.registerDialog.description);
    // No date, no change.
    await user.click(within(dialog).getByRole('button', { name: ta.registerDialog.confirm }));
    expect(await within(dialog).findByText(en.weldbooksUs.salesTax.setup.validation.registeredFromRequired)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Registered from'), { target: { value: '2026-02-01' } });
    await user.click(within(dialog).getByRole('button', { name: ta.registerDialog.confirm }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/sales-tax-agencies/sta_1', { status: 'registered', registeredFrom: '2026-02-01' });
    expect(toast.success).toHaveBeenCalledWith('Status changed to Registered');
  });

  it('starts from the registration date on file when re-registering a closed agency', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'closed', registeredFrom: '2025-04-01', registeredUntil: '2026-06-30' })} />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: ta.statusActions.registered }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Registered from')).toHaveValue('2025-04-01');
  });

  it('moves to monitoring or pending straight away, without a date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'registered' })} />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: ta.statusActions.monitoring }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/sales-tax-agencies/sta_1', { status: 'monitoring' }));
    expect(toast.success).toHaveBeenCalledWith('Status changed to Monitoring');
  });

  it('closes an agency only after a confirmation that says what it means', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'registered' })} />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: ta.statusActions.closed }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(ta.closeDialog.title);
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: ta.closeDialog.confirm }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/sales-tax-agencies/sta_1', { status: 'closed' }));
    expect(toast.success).toHaveBeenCalledWith('Status changed to Closed');
  });

  it('shows the server sentence when a change is refused', async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValue(new Error('The registration end date is before its start date'));
    renderWithProviders(<AgencyStatusMenu agency={makeAgency({ status: 'registered' })} />);
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: ta.statusActions.pending }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The registration end date is before its start date'));
  });
});
