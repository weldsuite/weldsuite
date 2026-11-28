import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { setRuntimeConfig } from '@/lib/runtime-config';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useParams: () => ({ projectId: 'prj_1' }) };
});
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined, currency?: string | null) => `${currency ?? 'EUR'} ${Number(value ?? 0).toFixed(2)}`,
    formatNumber: (value: string | number | null | undefined) => String(Number(value ?? 0)),
  }),
}));

import ProjectInvoicingPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const copy = en.weldbooksContactPage.flow.finance;
const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const finance = {
  projectId: 'prj_1',
  invoiced: [{ currency: 'EUR', amount: '4000.00' }],
  draft: [{ currency: 'EUR', amount: '950.00' }],
  unbilled: { hours: '12.5', amount: [{ currency: 'EUR', amount: '1187.50' }, { currency: 'USD', amount: '100.00' }] },
  costs: [{ currency: 'EUR', amount: '320.00' }],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  setRuntimeConfig(RUST);
  permissions.allowed = new Set(['invoices:read', 'invoices:create', 'time:read']);
  api.get.mockResolvedValue({ data: finance });
});
afterEach(() => setRuntimeConfig(null));

describe('a project’s invoicing figures', () => {
  it('shows what is invoiced, in draft, unbilled and the costs, per currency', async () => {
    renderWithProviders(<ProjectInvoicingPage />);
    expect((await screen.findByText(copy.invoiced)).closest('[data-slot="card"]')).toHaveTextContent('EUR 4000.00');
    expect(screen.getByText(copy.draft).closest('[data-slot="card"]')).toHaveTextContent('EUR 950.00');
    expect(screen.getByText(copy.unbilled).closest('[data-slot="card"]')).toHaveTextContent('12.5 h');
    // Two currencies stay two amounts.
    const value = screen.getByText(copy.unbilledAmount).closest('[data-slot="card"]');
    expect(value).toHaveTextContent('EUR 1187.50');
    expect(value).toHaveTextContent('+ USD 100.00');
    expect(screen.getByText(copy.costs).closest('[data-slot="card"]')).toHaveTextContent('EUR 320.00');
    expect(api.get).toHaveBeenCalledWith('/accounting-projects/prj_1/finance');
  });

  it('opens the Unbilled time page filtered to this project from "Invoice unbilled hours"', async () => {
    renderWithProviders(<ProjectInvoicingPage />);
    const link = await screen.findByRole('link', { name: copy.invoiceUnbilled });
    expect(link).toHaveAttribute('href', '/weldbooks/time/unbilled?projectId=prj_1');
  });

  it('offers no invoicing link when there are no hours to invoice or the member may not invoice', async () => {
    api.get.mockResolvedValue({ data: { ...finance, unbilled: { hours: '0', amount: [] } } });
    const { unmount } = renderWithProviders(<ProjectInvoicingPage />);
    await screen.findByText(copy.invoiced);
    expect(screen.queryByRole('link', { name: copy.invoiceUnbilled })).not.toBeInTheDocument();
    unmount();

    api.get.mockResolvedValue({ data: finance });
    permissions.allowed = new Set(['invoices:read']);
    renderWithProviders(<ProjectInvoicingPage />);
    await screen.findByText(copy.invoiced);
    expect(screen.queryByRole('link', { name: copy.invoiceUnbilled })).not.toBeInTheDocument();
  });

  it('leaves out the figures the server left out for a member who may not read time or bills', async () => {
    api.get.mockResolvedValue({ data: { projectId: 'prj_1', invoiced: [], draft: [] } });
    renderWithProviders(<ProjectInvoicingPage />);
    await screen.findByText(copy.invoiced);
    expect(screen.queryByText(copy.unbilled)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.costs)).not.toBeInTheDocument();
  });

  it('says a failure in words, and a lack of access without asking the server', async () => {
    api.get.mockRejectedValue(new Error('boom'));
    const { unmount } = renderWithProviders(<ProjectInvoicingPage />);
    await waitFor(() => expect(screen.getByText(copy.loadFailed)).toBeInTheDocument());
    unmount();

    api.get.mockReset();
    permissions.allowed = new Set();
    renderWithProviders(<ProjectInvoicingPage />);
    expect(screen.getByText(copy.noAccess)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
