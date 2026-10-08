import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { RateDialog } from './rate-dialog';
import { installPointerPolyfills, makeJurisdiction, makeRate, renderWithProviders } from '../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const open = makeRate({ id: 'stjr_open', rate: '6.2500', effectiveFrom: '2020-01-01', effectiveTo: null });
const ended = makeRate({ id: 'stjr_old', rate: '6.0000', effectiveFrom: '2010-01-01', effectiveTo: '2019-12-31' });
const texas = makeJurisdiction({ rates: [open, ended] });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.post.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  api.post.mockResolvedValue({ data: makeRate({ id: 'stjr_new' }) });
  api.patch.mockResolvedValue({ data: makeRate({ id: 'stjr_open' }) });
});

function renderDialog(props: Partial<React.ComponentProps<typeof RateDialog>> = {}) {
  const onOpenChange = vi.fn();
  renderWithProviders(<RateDialog jurisdiction={texas} open onOpenChange={onOpenChange} {...props} />);
  return { onOpenChange };
}

describe('RateDialog: adding a rate', () => {
  it('offers to end the open-ended rate, ticked, with the rate it would end', () => {
    renderDialog();
    const box = screen.getByRole('checkbox', { name: new RegExp(setup.rates.dialog.closePrevious) });
    expect(box).toBeChecked();
    expect(screen.getByText(/6\.25% \(date:2020-01-01\) has no end date/)).toBeInTheDocument();
  });

  it('sends "close previous" with the new rate and its start date', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText('Rate (%)'), '6.5');
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-11-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax-jurisdictions/stj_1/rates', {
      rate: 6.5,
      effectiveFrom: '2026-11-01',
      closePrevious: true,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith(setup.rates.saved);
  });

  it('leaves "close previous" out when it is unticked, so the server still guards overlaps', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Rate (%)'), '7');
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-11-01' } });
    await user.click(screen.getByRole('checkbox', { name: new RegExp(setup.rates.dialog.closePrevious) }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toEqual({ rate: 7, effectiveFrom: '2026-11-01' });
  });

  it('does not offer it when no rate is open-ended, or the new one starts before it', async () => {
    renderDialog({ jurisdiction: makeJurisdiction({ rates: [ended] }) });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('stops offering it when the start date moves before the open-ended rate', () => {
    renderDialog();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2019-01-01' } });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('refuses a rate that is not a percentage, without calling the API', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Rate (%)'), '120');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(setup.validation.percent)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the overlap sentence of the server and stays open', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('This rate overlaps the 6.25% rate that applies from 2020-01-01 onward.'));
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText('Rate (%)'), '6.5');
    await user.click(screen.getByRole('checkbox', { name: new RegExp(setup.rates.dialog.closePrevious) }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/overlaps the 6\.25% rate/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('RateDialog: editing a rate', () => {
  it('starts from the saved rate and sends a cleared end date as null', async () => {
    const user = userEvent.setup();
    renderDialog({ rate: ended });

    expect(screen.getByLabelText('Rate (%)')).toHaveValue('6');
    expect(screen.getByLabelText('Starts on')).toHaveValue('2010-01-01');
    expect(screen.getByLabelText('Ends on')).toHaveValue('2019-12-31');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/sales-tax-jurisdictions/stj_1/rates/stjr_old', {
      rate: 6,
      effectiveFrom: '2010-01-01',
      effectiveTo: null,
    });
  });
});
