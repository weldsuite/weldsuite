import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const customers = vi.hoisted(() => ({
  data: { data: [{ id: 'prt_1', name: 'Acme Corp', role: 'customer', kind: 'company', email: 'ap@acme.test' }] },
  isLoading: false,
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({ useAccountingCustomers: () => customers }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID', customerAndSupplier: 'Customer + vendor' },
  }),
}));
const panel = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: panel.open }),
  useObjectPanelUrlSync: panel.sync,
}));

import AccountingCustomersPage from './page';

beforeEach(() => {
  panel.open.mockReset();
  panel.sync.mockReset();
});

describe('AccountingCustomersPage', () => {
  it('opens a customer in the WeldBooks contact panel, synced to the customers list URL', async () => {
    renderWithProviders(<AccountingCustomersPage />);

    expect(panel.sync).toHaveBeenCalledWith('/weldbooks/customers');
    await userEvent.click(await screen.findByRole('button', { name: 'Acme Corp' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_1' });
  });
});
