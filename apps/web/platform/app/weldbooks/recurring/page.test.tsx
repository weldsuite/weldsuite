import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const recurring = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingRecurringInvoices: () => ({ data: { data: recurring.rows }, isLoading: false }),
  useAccountingContactNames: () => new Map([['ct_1', 'Acme']]),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: unknown) => String(value), formatDate: (value: unknown) => String(value) }),
}));

import RecurringInvoicesPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../fixed-assets/test-utils';
import { addIsFilter } from '../payment-runs/test-utils';

function template(id: string, name: string, status: string, frequency: string) {
  return {
    id,
    name,
    contactId: 'ct_1',
    frequency,
    nextIssueDate: '2026-12-01',
    status,
    templateData: { items: [{ quantity: 1, unitPrice: 100 }], currency: 'EUR' },
  };
}

describe('RecurringInvoicesPage', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    recurring.rows = [template('rec_1', 'Hosting', 'active', 'monthly'), template('rec_2', 'Support plan', 'paused', 'yearly')];
  });

  it('narrows the templates by status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoicesPage />);
    expect(screen.getByText('Hosting')).toBeInTheDocument();

    await addIsFilter(user, 'Status', 'Paused');

    await waitFor(() => expect(screen.queryByText('Hosting')).not.toBeInTheDocument());
    expect(screen.getByText('Support plan')).toBeInTheDocument();
  });

  it('narrows the templates by how often they run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoicesPage />);

    await addIsFilter(user, 'Frequency', 'Monthly');

    await waitFor(() => expect(screen.queryByText('Support plan')).not.toBeInTheDocument());
    expect(screen.getByText('Hosting')).toBeInTheDocument();
  });
});
