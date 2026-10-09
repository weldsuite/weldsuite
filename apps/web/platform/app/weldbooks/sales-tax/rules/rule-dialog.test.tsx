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

import { RuleDialog } from './rule-dialog';
import { installPointerPolyfills, makeAgency, renderWithProviders } from '../setup/test-support';
import type { SalesTaxRule } from '@/lib/api/domains/weldbooks-sales-tax-setup';

const setup = en.weldbooksUs.salesTax.setup;
const tr = setup.rules.dialog;

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.post.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  api.post.mockResolvedValue({ data: { id: 'str_new' } });
  api.patch.mockResolvedValue({ data: { id: 'str_1' } });
});

function renderDialog(props: Partial<React.ComponentProps<typeof RuleDialog>> = {}) {
  const onOpenChange = vi.fn();
  renderWithProviders(<RuleDialog agency={makeAgency()} open onOpenChange={onOpenChange} {...props} />);
  return { onOpenChange };
}

describe('RuleDialog', () => {
  it('starts as a taxable software rule that takes effect today', () => {
    renderDialog();
    expect(screen.getByRole('combobox', { name: tr.taxCode })).toHaveTextContent('Software as a service');
    expect(screen.getByLabelText(tr.effectiveFrom)).toHaveValue('2026-10-08');
    expect(screen.getByLabelText(tr.percent)).toHaveValue('100');
    expect(screen.getByRole('switch', { name: new RegExp(tr.taxable) })).toBeChecked();
  });

  it('saves the Texas SaaS rule: taxable on 80% from a date', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.clear(screen.getByLabelText(tr.percent));
    await user.type(screen.getByLabelText(tr.percent), '80');
    fireEvent.change(screen.getByLabelText(tr.effectiveFrom), { target: { value: '2027-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax-rules', {
      agencyId: 'sta_1',
      taxCode: 'saas',
      taxable: true,
      taxablePercent: 80,
      appliesToUse: 'any',
      effectiveFrom: '2027-01-01',
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith(setup.rules.created);
  });

  it('hides the share, the rate override and the use for a product that is not taxable', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('switch', { name: new RegExp(tr.taxable) }));

    expect(screen.queryByLabelText(tr.percent)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(tr.rateOverride)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ taxable: false, taxablePercent: 100 });
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('rateOverride');
  });

  it('sends a rate override and a use for business buyers (Maryland SaaS at 3%)', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(tr.rateOverride), '3');
    await user.click(screen.getByRole('combobox', { name: tr.use }));
    await user.click(await screen.findByRole('option', { name: 'Business use' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ rateOverride: 3, appliesToUse: 'business' });
  });

  it('refuses a share that is not a percentage', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.clear(screen.getByLabelText(tr.percent));
    await user.type(screen.getByLabelText(tr.percent), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(setup.validation.percent)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the overlap sentence of the server and stays open', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('A rule for saas already applies from 2000-01-01 onward. End it before adding one that overlaps.'));
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/already applies from 2000-01-01/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('edits a seeded shipping rule and patches it', async () => {
    const user = userEvent.setup();
    const rule: SalesTaxRule = {
      id: 'str_1',
      agencyId: 'sta_1',
      taxCode: 'shipping',
      taxable: false,
      taxablePercent: '100.0000',
      appliesToUse: 'any',
      rateOverride: null,
      effectiveFrom: '2000-01-01',
      effectiveTo: null,
      notes: 'shipping is not taxable in TX when stated separately (seeded; confirm before relying on it)',
    };
    renderDialog({ rule });

    expect(screen.getByRole('combobox', { name: tr.taxCode })).toHaveTextContent('Shipping');
    expect(screen.getByRole('switch', { name: new RegExp(tr.taxable) })).not.toBeChecked();
    expect(screen.getByLabelText(tr.notes)).toHaveValue(rule.notes);

    fireEvent.change(screen.getByLabelText(tr.effectiveTo), { target: { value: '2026-12-31' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/sales-tax-rules/str_1', {
      taxCode: 'shipping',
      taxable: false,
      taxablePercent: 100,
      appliesToUse: 'any',
      rateOverride: null,
      effectiveFrom: '2000-01-01',
      effectiveTo: '2026-12-31',
      notes: rule.notes,
    });
  });
});
