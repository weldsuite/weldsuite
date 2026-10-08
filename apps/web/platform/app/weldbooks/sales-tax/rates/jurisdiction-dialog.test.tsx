import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { JurisdictionDialog } from './jurisdiction-dialog';
import { installPointerPolyfills, makeAgency, makeJurisdiction, renderWithProviders } from '../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const td = setup.jurisdictions.dialog;

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.post.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  api.post.mockResolvedValue({ data: makeJurisdiction() });
  api.patch.mockResolvedValue({ data: makeJurisdiction() });
});

function renderDialog(props: Partial<React.ComponentProps<typeof JurisdictionDialog>> = {}) {
  const onOpenChange = vi.fn();
  renderWithProviders(<JurisdictionDialog agency={makeAgency()} open onOpenChange={onOpenChange} {...props} />);
  return { onOpenChange };
}

describe('JurisdictionDialog: adding', () => {
  it('starts the first rate on the day the registration starts', () => {
    renderDialog({ agency: makeAgency({ registeredFrom: '2026-03-01' }) });
    expect(screen.getByLabelText('Starts on')).toHaveValue('2026-03-01');
  });

  it('needs a name and a first rate before it saves anything', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(setup.validation.required)).toBeInTheDocument();
    expect(screen.getByText(setup.validation.rateRequired)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('saves the jurisdiction with its level, codes and first rate in one request', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ agency: makeAgency({ registeredFrom: '2026-01-01' }) });

    await user.click(screen.getByRole('combobox', { name: td.level }));
    await user.click(await screen.findByRole('option', { name: 'County' }));
    await user.type(screen.getByLabelText(td.name), 'Travis County');
    await user.type(screen.getByLabelText(td.code), '48453');
    await user.type(screen.getByLabelText('Rate (%)'), '0,5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax-jurisdictions', {
      agencyId: 'sta_1',
      level: 'county',
      name: 'Travis County',
      isActive: true,
      code: '48453',
      rate: { rate: 0.5, effectiveFrom: '2026-01-01' },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith(setup.jurisdictions.created);
  });

  it('refuses a first rate that is not a percentage', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(td.name), 'Texas');
    await user.type(screen.getByLabelText('Rate (%)'), '6.25.1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(setup.validation.percent)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('JurisdictionDialog: editing', () => {
  it('has no first rate to enter, starts from what is saved, and patches without touching the rates', async () => {
    const user = userEvent.setup();
    renderDialog({ jurisdiction: makeJurisdiction({ id: 'stj_9', name: 'Austin MTA', level: 'district', code: 'AUS' }) });

    expect(screen.queryByLabelText('Rate (%)')).not.toBeInTheDocument();
    expect(screen.getByLabelText(td.name)).toHaveValue('Austin MTA');
    expect(screen.getByLabelText(td.code)).toHaveValue('AUS');

    fireEvent.change(screen.getByLabelText(td.code), { target: { value: '' } });
    await user.click(screen.getByRole('switch', { name: new RegExp(td.active) }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/sales-tax-jurisdictions/stj_9', {
      level: 'district',
      name: 'Austin MTA',
      code: null,
      reportingCode: null,
      isActive: false,
    });
    expect(toast.success).toHaveBeenCalledWith(setup.jurisdictions.saved);
  });
});
