import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
  useNavigate: () => navigate,
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string) => value,
  formatDateTime: (value: string) => value,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ExceptionsCard, isOpenException, selectedTaxLineIds } from './exceptions-card';
import { installPointerPolyfills, makeReturn, renderWithProviders } from '../../shared/test-support';
import type { ExceptionItem, ReturnExceptions } from '@/lib/api/domains/weldbooks-sales-tax-center';

function item(overrides: Partial<ExceptionItem> = {}): ExceptionItem {
  return {
    key: 'credit_note|cn_1',
    document: { type: 'credit_note', id: 'cn_1', number: 'CM-0001', contactName: 'Acme Corp', date: '2026-09-12' },
    taxDate: '2026-09-12',
    postedAt: '2026-10-02T09:00:00.000Z',
    taxLineIds: ['tl_1', 'tl_2'],
    grossAmount: -500,
    taxableAmount: -500,
    taxAmount: -43.75,
    resolution: 'open',
    amendedByReturnId: null,
    countedByReturnId: null,
    ...overrides,
  };
}

function exceptions(overrides: Partial<ReturnExceptions> = {}): ReturnExceptions {
  const items = overrides.items ?? [item()];
  return {
    returnId: 'txr_1',
    applicable: true,
    items,
    latePayments: [],
    totals: {
      open: { documents: items.filter(isOpenException).length, taxAmount: -43.75 },
      carried_forward: { documents: 0, taxAmount: 0 },
      amended: { documents: 0, taxAmount: 0 },
    },
    ...overrides,
  };
}

const filed = makeReturn({ status: 'filed', filedAt: '2026-10-05T10:00:00.000Z', confirmationNumber: 'C1' });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.get.mockResolvedValue({ data: exceptions() });
});

describe('exception helpers', () => {
  it('treats open and partly resolved rows as waiting for a decision', () => {
    expect(isOpenException({ resolution: 'open' })).toBe(true);
    expect(isOpenException({ resolution: 'partial' })).toBe(true);
    expect(isOpenException({ resolution: 'carried_forward' })).toBe(false);
    expect(isOpenException({ resolution: 'amended' })).toBe(false);
  });

  it('collects the tax line ids of the selected open rows only', () => {
    const items = [
      item({ key: 'a', taxLineIds: ['1', '2'] }),
      item({ key: 'b', taxLineIds: ['3'], resolution: 'amended' }),
      item({ key: 'c', taxLineIds: ['4'], resolution: 'partial' }),
    ];
    expect(selectedTaxLineIds(items, new Set(['a', 'b', 'c']))).toEqual(['1', '2', '4']);
    expect(selectedTaxLineIds(items, new Set())).toEqual([]);
  });
});

describe('ExceptionsCard', () => {
  it('says changes show up once the return is filed', () => {
    renderWithProviders(<ExceptionsCard ret={makeReturn({ status: 'reviewed' })} canCarryForward canAmend />);
    expect(screen.getByText(/show here once the return is filed/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('lists the documents that changed after filing with their totals', async () => {
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);

    const row = await screen.findByTestId('exception-row');
    expect(within(row).getByRole('link', { name: 'CM-0001' })).toHaveAttribute('href', '/weldbooks/invoices/cn_1');
    expect(row).toHaveTextContent('Acme Corp');
    expect(row).toHaveTextContent('$-43.75');
    expect(row).toHaveTextContent('Open');
    expect(screen.getByTestId('exceptions-total-open')).toHaveTextContent('Open: 1 document, $-43.75 tax');
  });

  it('says nothing changed when there is nothing to decide', async () => {
    api.get.mockResolvedValue({ data: exceptions({ items: [], totals: { open: { documents: 0, taxAmount: 0 }, carried_forward: { documents: 0, taxAmount: 0 }, amended: { documents: 0, taxAmount: 0 } } }) });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);
    expect(await screen.findByText('No changes since filing')).toBeInTheDocument();
  });

  it('carries the selected rows forward', async () => {
    api.get.mockResolvedValue({
      data: exceptions({
        items: [
          item(),
          item({ key: 'invoice|inv_9', document: { type: 'invoice', id: 'inv_9', number: 'INV-9', contactName: null, date: '2026-09-20' }, taxLineIds: ['tl_9'] }),
        ],
      }),
    });
    api.post.mockResolvedValue({
      data: { ...filed, carriedRows: 2, taxAmount: -43.75, recalculate: [{ id: 'txr_next', status: 'calculated', periodEnd: '2026-12-31' }] },
    });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);
    const user = userEvent.setup();

    const carry = await screen.findByRole('button', { name: 'Carry forward selected' });
    expect(carry).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: 'Select CM-0001' }));
    expect(carry).toBeEnabled();
    await user.click(carry);

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/carry-forward', { taxLineIds: ['tl_1', 'tl_2'] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Carried 2 rows forward ($-43.75 tax)'));
    // Later open returns have to be recalculated to pick the rows up.
    expect(await screen.findByTestId('recalculate-note')).toHaveTextContent('2026-12-31');
  });

  it('carries every open row forward when none is selected', async () => {
    api.post.mockResolvedValue({ data: { ...filed, carriedRows: 2, taxAmount: -43.75, recalculate: [] } });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Carry forward all open' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/carry-forward', {}));
  });

  it('amends the return after confirmation and opens the amended return', async () => {
    api.post.mockResolvedValue({ data: { ...makeReturn({ id: 'txr_amend' }), exceptionRows: 2 } });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Amend return' }));
    expect(screen.getByText('Amend this return?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create amended return' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/amend'));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_amend' } }),
    );
  });

  it('does not offer to amend a return that was already amended', async () => {
    renderWithProviders(
      <ExceptionsCard ret={{ ...filed, amendments: [{ id: 'txr_amend', status: 'calculated', filedAt: null }] }} canCarryForward canAmend />,
    );
    await screen.findByTestId('exception-row');
    expect(screen.queryByRole('button', { name: 'Amend return' })).not.toBeInTheDocument();
    expect(screen.getByText(/This return was amended/)).toBeInTheDocument();
  });

  it('hides the decisions from someone who cannot make them', async () => {
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward={false} canAmend={false} />);
    await screen.findByTestId('exception-row');
    expect(screen.queryByRole('button', { name: /Carry forward/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Amend return' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows who resolved a row', async () => {
    api.get.mockResolvedValue({
      data: exceptions({ items: [item({ resolution: 'amended', amendedByReturnId: 'txr_amend' })] }),
    });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);

    const row = await screen.findByTestId('exception-row');
    expect(row).toHaveTextContent('Amended');
    expect(within(row).getByRole('link', { name: 'Amended return' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_amend');
    // A resolved row cannot be selected again.
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('lists the payments received after filing on a cash-basis return', async () => {
    api.get.mockResolvedValue({
      data: exceptions({
        items: [],
        latePayments: [{ invoiceId: 'inv_5', invoiceNumber: 'INV-5', contactName: 'Bolt Inc', amount: 250 }],
      }),
    });
    renderWithProviders(<ExceptionsCard ret={filed} canCarryForward canAmend />);

    const late = await screen.findByTestId('late-payments');
    expect(within(late).getByRole('link', { name: 'INV-5' })).toBeInTheDocument();
    expect(late).toHaveTextContent('$250.00');
  });
});
