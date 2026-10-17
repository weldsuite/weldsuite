import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
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
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingJournalEntries: () => ({
    isLoading: false,
    data: {
      data: [
        {
          id: 'je_1',
          date: '2026-02-03',
          entryNumber: 'JE-0001',
          reference: 'Opening balance',
          description: 'Year start',
          totalDebit: '250.00',
          totalCredit: '250.00',
        },
      ],
    },
  }),
}));

import JournalEntriesPage from './page';
import { renderWithProviders } from '../fixed-assets/test-utils';

describe('JournalEntriesPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    openPanel.mockReset();
  });

  it('opens an entry in the journal entry record panel by clicking its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalEntriesPage />);

    await user.click(await screen.findByRole('button', { name: 'Opening balance' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'journal_entry', id: 'je_1' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
