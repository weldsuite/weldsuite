import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const suppliers = vi.hoisted(() => ({
  data: { data: [{ id: 'prt_2', name: 'Paper Co', role: 'supplier', kind: 'company', email: 'hi@paper.test' }] },
  isLoading: false,
}));
vi.mock('@/hooks/queries/use-weldbooks-1099-queries', () => ({ useSupplierContacts: () => suppliers }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID', customerAndSupplier: 'Customer + vendor' },
    features: { form1099: false },
  }),
}));
const panel = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: panel.open }),
  useObjectPanelUrlSync: panel.sync,
}));

import AccountingSuppliersPage from './page';

beforeEach(() => {
  panel.open.mockReset();
  panel.sync.mockReset();
});

describe('AccountingSuppliersPage', () => {
  it('opens a supplier in the WeldBooks contact panel, synced to the suppliers list URL', async () => {
    renderWithProviders(<AccountingSuppliersPage />);

    expect(panel.sync).toHaveBeenCalledWith('/weldbooks/suppliers');
    await userEvent.click(await screen.findByRole('button', { name: 'Paper Co' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_2' });
  });
});
