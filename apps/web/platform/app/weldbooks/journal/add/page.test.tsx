import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ create: vi.fn(), dimensions: [] as unknown[] }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateJournalEntry: () => ({ mutateAsync: env.create, isPending: false }),
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_cash', code: '1000', name: 'Cash' },
        { id: 'acc_sales', code: '4000', name: 'Sales' },
      ],
    },
  }),
  useDimensionValues: () => ({ data: env.dimensions }),
}));
vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProjects: () => ({ data: { data: [{ id: 'proj_1', name: 'Portal' }] }, isLoading: false, isError: false }),
  useProject: () => ({ data: undefined }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    today: () => '2026-03-01',
  }),
}));

import AddJournalEntryPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const classRetail = { id: 'dim_c1', entityId: 'e', dimension: 'class', name: 'Retail', code: null, parentId: null, isActive: true };
const locationAustin = { id: 'dim_l1', entityId: 'e', dimension: 'location', name: 'Austin', code: null, parentId: null, isActive: true };

describe('AddJournalEntryPage: dimensions', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.create.mockReset().mockResolvedValue({});
    env.dimensions = [];
  });

  it('shows no class or location when the entity has none', () => {
    renderWithProviders(<AddJournalEntryPage />);
    expect(screen.queryByRole('combobox', { name: 'Class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Location' })).not.toBeInTheDocument();
  });

  it('sends the class and location of each line, and null for none', async () => {
    env.dimensions = [classRetail, locationAustin];
    const user = userEvent.setup();
    renderWithProviders(<AddJournalEntryPage />);

    // One class and one location picker per line.
    expect(screen.getAllByRole('combobox', { name: 'Class' })).toHaveLength(2);
    expect(screen.getAllByRole('combobox', { name: 'Location' })).toHaveLength(2);

    const accountPickers = screen.getAllByRole('combobox').filter((el) => !/Class|Location|Project/.test(el.getAttribute('aria-label') ?? ''));
    await user.click(accountPickers[0]);
    await user.click(await screen.findByRole('option', { name: /Cash/ }));
    await user.click(accountPickers[1]);
    await user.click(await screen.findByRole('option', { name: /Sales/ }));
    const amounts = screen.getAllByPlaceholderText('0.00');
    await user.type(amounts[0], '100');
    await user.type(amounts[3], '100');

    await user.click(screen.getAllByRole('combobox', { name: 'Class' })[1]);
    await user.click(await screen.findByRole('option', { name: 'Retail' }));
    await user.click(screen.getAllByRole('combobox', { name: 'Location' })[1]);
    await user.click(await screen.findByRole('option', { name: 'Austin' }));
    await user.click(screen.getAllByRole('combobox', { name: 'Project' })[1]);
    await user.click(await screen.findByRole('option', { name: 'Portal' }));

    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const payload = env.create.mock.calls[0][0];
    expect(payload.lines).toEqual([
      expect.objectContaining({ accountId: 'acc_cash', debit: '100', credit: '0', classId: null, locationId: null, projectId: null }),
      expect.objectContaining({ accountId: 'acc_sales', debit: '0', credit: '100', classId: 'dim_c1', locationId: 'dim_l1', projectId: 'proj_1' }),
    ]);
  });
});

describe('AddJournalEntryPage: account search', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.create.mockReset().mockResolvedValue({});
    env.dimensions = [];
  });

  it('narrows the chart of accounts by code or name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AddJournalEntryPage />);

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.type(await screen.findByPlaceholderText('Search by code or name'), '4000');
    expect(screen.getByRole('option', { name: /Sales/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Cash/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /Sales/ }));
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('4000 — Sales');
  });
});
