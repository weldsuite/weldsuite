import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string | null) => value ?? '—',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
vi.mock('../shared/sales-tax-frame', () => ({
  SalesTaxFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import CertificateReportsPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../shared/test-support';
import type { ExpiringCertificates, MissingCertificates } from '@/lib/api/domains/weldbooks-sales-tax-center';

const expiring: ExpiringCertificates = {
  asOf: '2026-10-08',
  days: 60,
  certificates: [
    {
      certificateId: 'cert_1',
      partyId: 'cus_1',
      customerName: 'Acme Corp',
      certificateNumber: 'RS-1001',
      reason: 'resale',
      form: 'mtc_uniform',
      blanket: true,
      states: ['WA', 'OR'],
      status: 'valid',
      expiresOn: '2026-10-20',
      expiryByState: [{ stateCode: 'WA', expiresOn: '2026-10-20' }],
      daysLeft: 12,
      expired: false,
      lastUsedOn: '2026-09-30',
    },
    {
      certificateId: 'cert_2',
      partyId: 'cus_2',
      customerName: null,
      certificateNumber: null,
      reason: 'nonprofit',
      form: 'state_form',
      blanket: false,
      states: ['TX'],
      status: 'expired',
      expiresOn: '2026-09-01',
      expiryByState: [],
      daysLeft: -37,
      expired: true,
      lastUsedOn: null,
    },
  ],
};

const missing: MissingCertificates = {
  asOf: '2026-10-08',
  certificates: [
    {
      documentType: 'invoice',
      documentId: 'inv_1',
      documentNumber: 'INV-1',
      customerId: 'cus_1',
      customerName: 'Acme Corp',
      stateCode: 'WA',
      saleDate: '2026-06-01',
      exemptSales: 1200,
      exemptReason: 'resale',
      cureDeadline: '2026-08-30',
      pastDeadline: true,
      daysLeft: -39,
    },
    {
      documentType: 'invoice',
      documentId: 'inv_2',
      documentNumber: 'INV-2',
      customerId: null,
      customerName: 'Walk-in',
      stateCode: 'WA',
      saleDate: '2026-09-20',
      exemptSales: 300,
      exemptReason: null,
      cureDeadline: '2026-12-19',
      pastDeadline: false,
      daysLeft: 72,
    },
  ],
  totals: { documents: 2, exemptSales: 1500, pastDeadline: 1 },
};

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/sales-tax/reports/certificates/expiring')) return { data: expiring };
    if (path.startsWith('/sales-tax/reports/certificates/missing')) return { data: missing };
    throw new Error(`unexpected GET ${path}`);
  });
});

describe('Expiring certificates', () => {
  it('asks for the next 60 days and lists the certificates with the time left', async () => {
    renderWithProviders(<CertificateReportsPage />);

    const rows = await screen.findAllByTestId('expiring-certificate');
    expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/certificates/expiring?days=60');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent('RS-1001');
    expect(rows[0]).toHaveTextContent('Blanket');
    expect(rows[0]).toHaveTextContent('Resale');
    expect(rows[0]).toHaveTextContent('MTC uniform');
    expect(rows[0]).toHaveTextContent('WA, OR');
    expect(rows[0]).toHaveTextContent('Expires in 12 days');
    expect(rows[0]).toHaveTextContent('2026-09-30');
  });

  it('links the customer and marks what already lapsed', async () => {
    renderWithProviders(<CertificateReportsPage />);

    const [soon, lapsed] = await screen.findAllByTestId('expiring-certificate');
    expect(within(soon!).getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('href', '/weldbooks/customers/cus_1');
    expect(soon).toHaveAttribute('data-urgency', 'soon');
    expect(lapsed).toHaveAttribute('data-urgency', 'expired');
    expect(lapsed).toHaveTextContent('Expired 37 days ago');
    expect(lapsed).toHaveTextContent('Never used');
    expect(within(lapsed!).getByText('Expired', { selector: 'span[data-slot="badge"]' })).toBeInTheDocument();
  });

  it('looks further ahead when asked', async () => {
    renderWithProviders(<CertificateReportsPage />);
    const user = userEvent.setup();

    await screen.findAllByTestId('expiring-certificate');
    await user.click(screen.getByLabelText('Expiring within'));
    await user.click(await screen.findByRole('option', { name: '180 days' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/certificates/expiring?days=180'));
  });

  it('says so when nothing expires', async () => {
    api.get.mockResolvedValue({ data: { ...expiring, certificates: [] } });
    renderWithProviders(<CertificateReportsPage />);
    expect(await screen.findByText('No certificates expiring')).toBeInTheDocument();
  });
});

describe('Missing certificates', () => {
  async function openMissing() {
    renderWithProviders(<CertificateReportsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Missing' }));
    return user;
  }

  it('lists the exempt sales without a certificate with their cure deadline', async () => {
    await openMissing();

    const rows = await screen.findAllByTestId('missing-certificate');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('INV-1');
    expect(rows[0]).toHaveTextContent('$1200.00');
    expect(rows[0]).toHaveTextContent('2026-08-30');
    expect(rows[1]).toHaveTextContent('72 days left');
  });

  it('highlights a sale that is past its deadline and is now counted as taxable', async () => {
    await openMissing();

    const [past, open] = await screen.findAllByTestId('missing-certificate');
    expect(past).toHaveAttribute('data-past-deadline', 'true');
    expect(past).toHaveTextContent('Counted as taxable');
    expect(past).toHaveTextContent('Past by 39 days');
    expect(open).toHaveAttribute('data-past-deadline', 'false');
    expect(open).not.toHaveTextContent('Counted as taxable');
    expect(screen.getByTestId('missing-past-deadline')).toHaveTextContent('1');
  });

  it('links the customer when the sale has one', async () => {
    await openMissing();

    const [first, second] = await screen.findAllByTestId('missing-certificate');
    expect(within(first!).getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('href', '/weldbooks/customers/cus_1');
    expect(within(second!).queryByRole('link', { name: 'Walk-in' })).not.toBeInTheDocument();
  });

  it('narrows to a date range', async () => {
    const user = await openMissing();

    await screen.findAllByTestId('missing-certificate');
    await user.type(screen.getByLabelText('From'), '2026-09-01');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sales-tax/reports/certificates/missing?from=2026-09-01'));
  });

  it('says so when no certificate is missing', async () => {
    api.get.mockResolvedValue({ data: { ...missing, certificates: [], totals: { documents: 0, exemptSales: 0, pastDeadline: 0 } } });
    await openMissing();
    expect(await screen.findByText('No missing certificates')).toBeInTheDocument();
  });
});
