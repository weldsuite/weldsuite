import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { GroupConfig } from '@/components/entity-list';

const query = vi.hoisted(() => ({ filters: undefined as unknown, rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingInvoices: (filters: unknown) => {
    query.filters = filters;
    return { data: { data: query.rows }, isLoading: false };
  },
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
  }: {
    items: Array<{ id: string; invoiceNumber: string }>;
    groups: GroupConfig<{ id: string; invoiceNumber: string }>[];
  }) => (
    <div>
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
