import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const query = vi.hoisted(() => ({
  filters: [] as Array<{ type?: string; search?: string; status?: string }>,
  rows: [] as Array<Record<string, unknown>>,
}));

// Answers like the server: a `status` narrows the credit notes to that status.
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useInfiniteAccountingInvoices: (filters: { type?: string; search?: string; status?: string }) => {
    query.filters.push(filters);
    const rows = filters.status ? query.rows.filter((row) => row.status === filters.status) : query.rows;
    return { data: { rows }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  },
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: unknown) => String(value), formatDate: (value: unknown) => String(value) }),
}));

import CreditNotesPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../fixed-assets/test-utils';
import { addIsFilter } from '../payment-runs/test-utils';

function creditNote(id: string, status: string) {
  return { id, invoiceNumber: `CN-${id}`, contactName: 'Acme', issueDate: null, totalAmount: -10, status };
}

describe('CreditNotesPage', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    query.filters = [];
    query.rows = [creditNote('1', 'draft'), creditNote('2', 'paid')];
  });

  it('asks only for credit notes', () => {
    renderWithProviders(<CreditNotesPage />);
    expect(query.filters.at(-1)).toMatchObject({ type: 'credit_note' });
    expect(screen.getByText('CN-1')).toBeInTheDocument();
    expect(screen.getByText('CN-2')).toBeInTheDocument();
  });

  it('asks the server for the status the Filter picks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreditNotesPage />);

    await addIsFilter(user, 'Status', 'Paid');

    await waitFor(() => expect(query.filters.at(-1)).toMatchObject({ type: 'credit_note', status: 'paid' }));
    expect(screen.queryByText('CN-1')).not.toBeInTheDocument();
    expect(screen.getByText('CN-2')).toBeInTheDocument();
  });
});
