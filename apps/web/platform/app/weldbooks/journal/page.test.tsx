import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const navigate = vi.fn();
const openPanel = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string | null) => value ?? '',
    formatMonth: (value: string | null) => value ?? '',
  }),
}));
const journal = vi.hoisted(() => ({
  filters: vi.fn(),
  fetchNextPage: vi.fn(),
  hasNextPage: false,
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useInfiniteAccountingJournalEntries: (filters: unknown) => {
    journal.filters(filters);
    return {
      isLoading: false,
      hasNextPage: journal.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: journal.fetchNextPage,
      data: {
        rows: [
          {
            id: 'je_1',
            date: '2026-02-03',
            entryNumber: 'JE-0001',
            reference: 'Opening balance',
            description: 'Year start',
            status: 'draft',
            sourceType: 'bank_reconciliation',
            totalDebit: '250.00',
            totalCredit: '250.00',
          },
        ],
        totalCount: 120,
      },
    };
  },
}));

import JournalEntriesPage from './page';
import { renderWithProviders } from '../fixed-assets/test-utils';

describe('JournalEntriesPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    openPanel.mockReset();
    journal.filters.mockReset();
    journal.fetchNextPage.mockReset();
    journal.hasNextPage = false;
  });

  it('opens an entry in the journal entry record panel by clicking its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalEntriesPage />);

    await user.click(await screen.findByRole('button', { name: 'Opening balance' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'journal_entry', id: 'je_1' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows whether an entry is a draft or posted', async () => {
    renderWithProviders(<JournalEntriesPage />);

    expect(await screen.findByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows where an entry came from in words, not as the raw code', async () => {
    renderWithProviders(<JournalEntriesPage />);

    expect(await screen.findByText('Bank reconciliation')).toBeInTheDocument();
    expect(screen.queryByText(/bank_reconciliation/)).not.toBeInTheDocument();
  });

  it('asks the server for the search text, a page at a time', async () => {
    const user = userEvent.setup();
    journal.hasNextPage = true;
    renderWithProviders(<JournalEntriesPage />);

    expect(journal.filters).toHaveBeenLastCalledWith({ status: undefined, search: '' });
    await user.type((await screen.findAllByPlaceholderText('Search entries...'))[0], 'rent');
    await waitFor(() =>
      expect(journal.filters).toHaveBeenLastCalledWith({ status: undefined, search: 'rent' }),
    );
  });
});
