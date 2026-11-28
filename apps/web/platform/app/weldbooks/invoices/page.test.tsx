import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { GroupConfig } from '@/components/entity-list';

const query = vi.hoisted(() => ({
  filters: undefined as unknown,
  rows: [] as Array<Record<string, unknown>>,
  search: '',
  replace: vi.fn(),
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useInfiniteAccountingInvoices: (filters: unknown) => {
    query.filters = filters;
    return { data: { rows: query.rows }, isLoading: false };
  },
}));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: query.replace }),
  usePathname: () => '/weldbooks/invoices',
  useSearchParams: () => new URLSearchParams(query.search),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({ labels: { creditNotes: 'Credit memos' } }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: vi.fn() }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: unknown) => String(value), formatDate: (value: unknown) => String(value) }),
}));
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
// The list itself is tested on its own: here only which group each invoice lands in matters.
vi.mock('@/components/accounting/weldbooks-entity-list', () => ({
  WeldbooksEntityList: ({
    items,
    groups,
    filters,
    activeFilters,
  }: {
    items: Array<{ id: string; invoiceNumber: string }>;
    groups: GroupConfig<{ id: string; invoiceNumber: string }>[];
    filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
    activeFilters: Array<{ field: string; operator: string; value: string }>;
  }) => (
    <div>
      <output data-testid="active-filters">{JSON.stringify(activeFilters.map((f) => [f.field, f.operator, f.value]))}</output>
      <output data-testid="show-options">
        {JSON.stringify(filters.find((f) => f.field === 'show')?.options.map((o) => o.label))}
      </output>
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label}>
          {items.filter(group.filter).map((item) => (
            <span key={item.id}>{item.invoiceNumber}</span>
          ))}
        </section>
      ))}
    </div>
  ),
}));

import InvoicesPage from './page';
import { renderWithProviders } from './components/test-utils';

function invoice(id: string, status: string) {
  return { id, invoiceNumber: `INV-${id}`, contactName: 'Acme', issueDate: null, dueDate: null, totalAmount: 10, status };
}

describe('InvoicesPage', () => {
  beforeEach(() => {
    query.search = '';
    query.replace.mockReset();
    query.rows = [
      invoice('1', 'sent'),
      invoice('2', 'partial'),
      invoice('3', 'paid'),
      invoice('4', 'cancelled'),
    ];
  });

  it('asks only for invoices, so credit notes stay in their own list', () => {
    renderWithProviders(<InvoicesPage />);
    expect(query.filters).toMatchObject({ type: 'invoice' });
  });

  it('shows every invoice and no filter pill when the address carries none', () => {
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('active-filters')).toHaveTextContent('[]');
    expect(query.filters).toMatchObject({ type: 'invoice', status: undefined, overdue: undefined });
  });

  it('reads the Status filter from ?status= and asks the server for it', () => {
    query.search = 'status=sent';
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('active-filters')).toHaveTextContent('[["status","is","sent"]]');
    expect(query.filters).toMatchObject({ status: 'sent' });
  });

  it('ignores a status the list does not know instead of showing an empty list', () => {
    query.search = 'status=bogus';
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('active-filters')).toHaveTextContent('[]');
    expect(query.filters).toMatchObject({ status: undefined });
  });

  it('opens the overdue view with the server filter and without drafts, paid or cancelled invoices', () => {
    query.search = 'show=overdue';
    query.rows = [invoice('1', 'overdue'), invoice('2', 'draft'), invoice('3', 'paid'), invoice('4', 'partial')];
    renderWithProviders(<InvoicesPage />);
    expect(query.filters).toMatchObject({ type: 'invoice', overdue: 'true' });
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('INV-4')).toBeInTheDocument();
    expect(screen.queryByText('INV-2')).not.toBeInTheDocument();
    expect(screen.queryByText('INV-3')).not.toBeInTheDocument();
  });

  it('opens the open view with the invoices that still wait for their money', () => {
    query.search = 'show=open';
    query.rows = [invoice('1', 'sent'), invoice('2', 'draft'), invoice('3', 'paid')];
    renderWithProviders(<InvoicesPage />);
    expect(query.filters).toMatchObject({ type: 'invoice', overdue: undefined });
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.queryByText('INV-2')).not.toBeInTheDocument();
    expect(screen.queryByText('INV-3')).not.toBeInTheDocument();
  });

  it('lists credit notes through the same list API with type credit_note', () => {
    query.search = 'show=credit_notes';
    renderWithProviders(<InvoicesPage />);
    expect(query.filters).toMatchObject({ type: 'credit_note' });
    expect(screen.getByTestId('active-filters')).toHaveTextContent('[["show","is","credit_notes"]]');
  });

  it('names the credit notes view by the jurisdiction wording', () => {
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('show-options')).toHaveTextContent('Credit memos');
  });

  it('groups a partially paid invoice apart from the sent ones', () => {
    renderWithProviders(<InvoicesPage />);

    const partial = screen.getByRole('region', { name: 'Partially paid' });
    expect(within(partial).getByText('INV-2')).toBeInTheDocument();
    const sent = screen.getByRole('region', { name: 'Sent' });
    expect(within(sent).getByText('INV-1')).toBeInTheDocument();
    expect(within(sent).queryByText('INV-2')).not.toBeInTheDocument();
  });

  it('keeps every other status in its own group, with a catch-all for the rest', () => {
    renderWithProviders(<InvoicesPage />);
    expect(within(screen.getByRole('region', { name: 'Paid' })).getByText('INV-3')).toBeInTheDocument();
    const other = screen.getAllByRole('region').find((region) => within(region).queryByText('INV-4'));
    expect(other).toBeDefined();
  });
});
