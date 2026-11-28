import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  search: '',
  listQuotes: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: { listQuotes: env.listQuotes },
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return {
    Link: HrefLink,
    useRouter: () => ({ push: env.push, replace: env.replace }),
    usePathname: () => '/weldbooks/quotes',
    useSearchParams: () => new URLSearchParams(env.search),
  };
});
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: unknown) => `€${value}`,
    formatDate: (value: string | null | undefined) => (value ? `d:${value}` : '—'),
  }),
}));

import QuotesPage from './page';
import { renderWithProviders } from '../invoices/components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  quoteNumber: `OFF-${id}`,
  name: `Project ${id}`,
  contactId: 'c_1',
  contactName: 'Jansen Bouw',
  total: '1210.00',
  currency: 'EUR',
  status: 'sent',
  validUntil: '2026-12-31',
  sentAt: '2026-11-03T09:00:00Z',
  viewedAt: null,
  acceptedAt: null,
  invoiceIds: [],
  ...overrides,
});

describe('QuotesPage', () => {
  beforeEach(() => {
    env.search = '';
    env.listQuotes.mockReset();
    env.push.mockReset();
    env.open.mockReset();
    env.listQuotes.mockResolvedValue({
      data: [
        row('1'),
        row('2', { status: 'accepted', viewedAt: '2026-11-04T09:00:00Z', acceptedAt: '2026-11-05T09:00:00Z', invoiceIds: ['i1', 'i2'] }),
      ],
      pagination: { totalCount: 2, hasMore: false },
    });
  });
  afterEach(() => setRuntimeConfig(null));

  it('lists the quotes with number, name, contact, total, valid until and status', async () => {
    setRuntimeConfig(RUST);
    renderWithProviders(<QuotesPage />);
    expect(await screen.findByText('OFF-1')).toBeInTheDocument();
    expect(screen.getByText('Project 1')).toBeInTheDocument();
    expect(screen.getAllByText('Jansen Bouw').length).toBeGreaterThan(0);
    expect(screen.getAllByText('€1210.00')).toHaveLength(2);
    expect(screen.getAllByText('d:2026-12-31')).toHaveLength(2);
    // The status chip and the progress chip both say it.
    expect(screen.getAllByText('Accepted')).toHaveLength(2);
  });

  it('shows the sent, viewed and accepted chips and how many invoices were made', async () => {
    setRuntimeConfig(RUST);
    renderWithProviders(<QuotesPage />);
    await screen.findByText('OFF-2');
    expect(screen.getAllByText('Sent', { selector: 'span' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Viewed')).toBeInTheDocument();
    expect(screen.getByText('2 invoices')).toBeInTheDocument();
  });

  it('shows the invoices made from a quote as chips that open them, in place of the count, when the rows carry them', async () => {
    setRuntimeConfig(RUST);
    env.listQuotes.mockResolvedValue({
      data: [
        row('2', {
          status: 'accepted',
          invoiceIds: ['i1', 'i2', 'i3'],
          invoices: [
            { id: 'i1', invoiceNumber: 'F-1', status: 'paid' },
            { id: 'i2', invoiceNumber: null, status: 'draft' },
            { id: 'i3', invoiceNumber: 'F-3', status: 'sent' },
          ],
        }),
      ],
      pagination: { totalCount: 1, hasMore: false },
    });
    renderWithProviders(<QuotesPage />);
    await screen.findByText('OFF-2');
    expect(screen.getByText('F-1')).toBeInTheDocument();
    expect(screen.getByText('Draft invoice')).toBeInTheDocument();
    // Two chips and "+1": the third is on the quote's panel.
    expect(screen.queryByText('F-3')).not.toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.queryByText('3 invoices')).not.toBeInTheDocument();
  });

  it('asks the server for the status in the address and for the first page', async () => {
    setRuntimeConfig(RUST);
    env.search = 'status=accepted';
    renderWithProviders(<QuotesPage />);
    await waitFor(() => expect(env.listQuotes).toHaveBeenCalled());
    expect(env.listQuotes).toHaveBeenCalledWith({ status: 'accepted', search: undefined, page: 1, pageSize: 25 });
  });

  it('ignores a status it does not know instead of showing an empty list', async () => {
    setRuntimeConfig(RUST);
    env.search = 'status=bogus';
    renderWithProviders(<QuotesPage />);
    await waitFor(() => expect(env.listQuotes).toHaveBeenCalled());
    expect(env.listQuotes.mock.calls[0][0]).toMatchObject({ status: undefined });
  });

  it('opens a quote as a panel and starts a new quote on its own page', async () => {
    const user = userEvent.setup();
    setRuntimeConfig(RUST);
    renderWithProviders(<QuotesPage />);
    await screen.findByText('OFF-1');
    await user.click(screen.getByRole('button', { name: 'OFF-1' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'quote', id: '1' });
    await user.click(screen.getByRole('button', { name: 'New quote' }));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/quotes/add');
  });

  it('says there are no quotes yet, with a way to make the first', async () => {
    setRuntimeConfig(RUST);
    env.listQuotes.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false } });
    renderWithProviders(<QuotesPage />);
    expect(await screen.findByText('No quotes yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New quote' }).length).toBeGreaterThanOrEqual(1);
  });
});
