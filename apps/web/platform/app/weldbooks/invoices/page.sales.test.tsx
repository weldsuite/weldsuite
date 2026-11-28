/**
 * The Invoices list in the sales phase (Rust only): the extra columns, bulk
 * reminders on overdue invoices, the "New credit note" entry and the
 * "e-mail bounced" view, and that Global's list stays as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { ColumnDef } from '@/components/entity-list';
import type { WeldbooksListSelection } from '@/components/accounting/weldbooks-entity-list';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  search: '',
  canUpdate: true,
  canCreate: true,
  filters: undefined as unknown,
  remindBulk: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (key: string) => (key === 'invoices:update' ? env.canUpdate : env.canCreate),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  accountingKeys: { invoices: { all: ['accounting', 'invoices'], list: (f: unknown) => ['accounting', 'invoices', 'list', f], detail: (id: string) => ['accounting', 'invoices', 'detail', id] }, journalEntries: { all: [] }, dashboard: () => [], settings: () => ['accounting', 'settings'], all: ['accounting'] },
  useInfiniteAccountingInvoices: (filters: unknown) => {
    env.filters = filters;
    return { data: { rows: env.rows }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  },
}));
vi.mock('@/lib/api/domains/weldbooks-sales', () => ({ salesApi: { remindBulk: env.remindBulk } }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: env.push, replace: vi.fn() }),
  usePathname: () => '/weldbooks/invoices',
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useJurisdictionLabels: () => ({ labels: { creditNotes: 'Credit memos' } }) }));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: vi.fn() }), useObjectPanelUrlSync: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: unknown) => `€${value}`, formatDate: (value: unknown) => String(value) }),
}));
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./components/new-credit-note-dialog', () => ({
  NewCreditNoteDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="New credit note dialog" /> : null),
}));
// The list itself has its own tests: here the columns, the selection and the New menu are what matter.
vi.mock('@/components/accounting/weldbooks-entity-list', () => ({
  WeldbooksEntityList: ({
    items,
    columns,
    selection,
    createButton,
    filters,
  }: {
    items: Array<{ id: string; invoiceNumber: string }>;
    columns: ColumnDef<{ id: string; invoiceNumber: string }>[];
    selection?: WeldbooksListSelection<{ id: string; invoiceNumber: string }>;
    createButton: { label: string; onClick: () => void; more?: Array<{ label: string; onClick: () => void }> };
    filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
  }) => (
    <div>
      <output data-testid="column-ids">{columns.map((column) => column.id).join(',')}</output>
      <output data-testid="show-options">{filters.find((f) => f.field === 'show')?.options.map((o) => o.value).join(',')}</output>
      {createButton.more?.map((entry) => (
        <button key={entry.label} type="button" onClick={entry.onClick}>
          {entry.label}
        </button>
      ))}
      {selection ? (
        <div>
          <button type="button" onClick={() => selection.onToggleAll(true)}>
            select all
          </button>
          <output data-testid="selected">{[...selection.selectedIds].sort().join(',')}</output>
          {selection.selectedIds.size > 0 ? selection.actions : null}
        </div>
      ) : null}
      {items.map((item) => (
        <div key={item.id} data-testid={`row-${item.id}`} data-selectable={selection ? String(selection.isSelectable?.(item) ?? true) : 'n/a'}>
          {columns.map((column) => (
            <div key={column.id} data-column={column.id}>
              {column.render(item, { onEdit: () => {}, onDelete: () => {}, onDuplicate: () => {}, onUpdate: () => {} })}
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import InvoicesPage from './page';
import { renderWithProviders } from './components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'invoice',
    invoiceNumber: `INV-${id}`,
    contactName: 'Acme',
    issueDate: daysAgo(40),
    dueDate: daysAgo(12),
    total: '121.00',
    balanceDue: '121.00',
    currency: 'EUR',
    status: 'overdue',
    ...overrides,
  };
}

describe('InvoicesPage in the sales phase', () => {
  beforeEach(() => {
    env.search = '';
    env.canUpdate = true;
    env.canCreate = true;
    env.remindBulk.mockReset();
    env.push.mockReset();
    env.rows = [
      invoice('1', { emailHistory: [{ type: 'viewed', at: '2026-11-04T10:00:00Z' }, { type: 'viewed', at: '2026-11-05T10:00:00Z' }, { type: 'viewed', at: '2026-11-06T10:00:00Z' }], reminderLevel: 2 }),
      invoice('2', { status: 'sent', dueDate: daysAgo(-10), emailHistory: [{ type: 'sent', at: '2026-11-04T10:00:00Z' }, { type: 'bounced', at: '2026-11-04T10:01:00Z', error: 'no mailbox' }] }),
      invoice('3', { status: 'paid', balanceDue: '0.00' }),
    ];
  });
  afterEach(() => setRuntimeConfig(null));

  it('keeps Global’s columns and has no selection or credit note entry there', () => {
    setRuntimeConfig(null);
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('column-ids')).toHaveTextContent('number,contact,issueDate,dueDate,total,status');
    expect(screen.queryByTestId('selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New credit note' })).not.toBeInTheDocument();
    expect(screen.getByTestId('show-options')).toHaveTextContent('open,overdue,credit_notes');
  });

  it('adds balance due, days overdue, last reminder and views', () => {
    setRuntimeConfig(RUST);
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('column-ids')).toHaveTextContent(
      'number,contact,issueDate,dueDate,total,balanceDue,daysOverdue,reminder,viewed,status',
    );
    const row = screen.getByTestId('row-1');
    expect(within(row).getByText('€121.00', { selector: '[data-column="balanceDue"] *' })).toBeInTheDocument();
    expect(row.querySelector('[data-column="daysOverdue"]')).toHaveTextContent('12 days overdue');
    expect(row.querySelector('[data-column="reminder"]')).toHaveTextContent('Reminder 2');
    expect(row.querySelector('[data-column="viewed"]')).toHaveTextContent('Viewed 3 times');
  });

  it('says the same in one line for a list too narrow for the columns', () => {
    setRuntimeConfig(RUST);
    renderWithProviders(<InvoicesPage />);
    expect(within(screen.getByTestId('row-1')).getByTestId('follow-up-line')).toHaveTextContent('12 days overdue · viewed 3 times');
    expect(within(screen.getByTestId('row-2')).getByTestId('follow-up-line')).toHaveTextContent('e-mail bounced');
    expect(within(screen.getByTestId('row-3')).queryByTestId('follow-up-line')).not.toBeInTheDocument();
  });

  it('warns about a bounced e-mail next to the status', () => {
    setRuntimeConfig(RUST);
    renderWithProviders(<InvoicesPage />);
    expect(within(screen.getByTestId('row-2').querySelector('[data-column="status"]') as HTMLElement).getByText('E-mail bounced')).toBeInTheDocument();
    expect(screen.getByTestId('row-1').querySelector('[data-column="status"]')).not.toHaveTextContent('E-mail bounced');
  });

  it('lets only overdue invoices that wait for money be selected, and sends reminders for them', async () => {
    const user = userEvent.setup();
    setRuntimeConfig(RUST);
    env.rows.push(invoice('4', { status: 'partial', balanceDue: '20.00' }), invoice('5', { type: 'credit_note' }));
    env.remindBulk.mockResolvedValue({
      data: {
        sent: [{ invoiceIds: ['1', '4'], level: 2, to: ['klant@example.test'], messageId: 'm1' }],
        skipped: [],
      },
    });
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('row-1')).toHaveAttribute('data-selectable', 'true');
    expect(screen.getByTestId('row-2')).toHaveAttribute('data-selectable', 'false');
    expect(screen.getByTestId('row-3')).toHaveAttribute('data-selectable', 'false');
    expect(screen.getByTestId('row-4')).toHaveAttribute('data-selectable', 'true');
    expect(screen.getByTestId('row-5')).toHaveAttribute('data-selectable', 'false');

    await user.click(screen.getByRole('button', { name: 'select all' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('1,4');
    await user.click(screen.getByRole('button', { name: 'Send 2 reminders' }));
    // Confirm first: this e-mails customers.
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Send reminders for 2 invoices?');
    expect(env.remindBulk).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Send reminders' }));
    await waitFor(() => expect(env.remindBulk).toHaveBeenCalledWith(['1', '4']));
    // The summary names who got what, with the invoice numbers, and the selection is cleared.
    const result = await screen.findByRole('dialog', { name: 'Reminders' });
    expect(within(result).getByTestId('bulk-sent')).toHaveTextContent('Reminder 2 to klant@example.test for INV-1, INV-4');
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent(''));
  });

  it('offers no selection to a member who may not update invoices', () => {
    setRuntimeConfig(RUST);
    env.canUpdate = false;
    renderWithProviders(<InvoicesPage />);
    expect(screen.queryByTestId('selected')).not.toBeInTheDocument();
  });

  it('offers no selection where the edition has no reminders', () => {
    setRuntimeConfig({ ...RUST, unavailableFeatures: ['books-reminders'] });
    renderWithProviders(<InvoicesPage />);
    expect(screen.queryByTestId('selected')).not.toBeInTheDocument();
  });

  it('adds New credit note to the New menu, which opens the picker', async () => {
    const user = userEvent.setup();
    setRuntimeConfig(RUST);
    renderWithProviders(<InvoicesPage />);
    await user.click(screen.getByRole('button', { name: 'New credit note' }));
    expect(screen.getByRole('dialog', { name: 'New credit note dialog' })).toBeInTheDocument();
  });

  it('leaves New credit note out for a member who may not create invoices', () => {
    setRuntimeConfig(RUST);
    env.canCreate = false;
    renderWithProviders(<InvoicesPage />);
    expect(screen.queryByRole('button', { name: 'New credit note' })).not.toBeInTheDocument();
  });

  it('opens the bounced view with only the invoices whose last e-mail bounced', () => {
    setRuntimeConfig(RUST);
    env.search = 'show=undelivered';
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByTestId('show-options')).toHaveTextContent('open,overdue,credit_notes,undelivered');
    expect(screen.queryByTestId('row-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('row-3')).not.toBeInTheDocument();
  });
});
