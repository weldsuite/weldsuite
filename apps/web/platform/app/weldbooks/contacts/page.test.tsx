import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const env = vi.hoisted(() => ({
  search: '',
  replace: vi.fn(),
  queryArgs: undefined as unknown,
  rows: [] as Array<Record<string, unknown>>,
  features: { form1099: false },
  createIntent: vi.fn(),
}));

vi.mock('@/hooks/queries/use-weldbooks-1099-queries', () => ({
  useInfiniteContacts: (args: unknown) => {
    env.queryArgs = args;
    return {
      data: { rows: env.rows },
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
}));
vi.mock('@/hooks/use-create-intent', () => ({ useCreateIntent: env.createIntent }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: env.replace }),
  usePathname: () => '/weldbooks/contacts',
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: {
      supplier: 'Vendor',
      suppliers: 'Vendors',
      taxId: 'EIN',
      registrationId: 'State ID',
      customerAndSupplier: 'Customer + vendor',
    },
    features: env.features,
  }),
}));
const panel = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: panel.open }),
  useObjectPanelUrlSync: panel.sync,
}));
// The library select has its own stories: here only how the page wires it matters.
vi.mock('@weldsuite/ui/components/filter-select', () => ({
  FilterSelect: ({
    value,
    onChange,
    options,
    allLabel,
    ariaLabel,
  }: {
    value: string | undefined;
    onChange: (next: string | undefined) => void;
    options: Array<{ value: string; label: string }>;
    allLabel: string;
    ariaLabel: string;
  }) => (
    <select aria-label={ariaLabel} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import ContactsPage from './page';

const CUSTOMER = { id: 'prt_1', name: 'Acme Corp', role: 'customer', kind: 'company', email: 'ap@acme.test' };
const SUPPLIER = { id: 'prt_2', name: 'Paper Co', role: 'supplier', kind: 'company', email: 'hi@paper.test' };

beforeEach(() => {
  env.search = '';
  env.replace.mockReset();
  env.queryArgs = undefined;
  env.rows = [CUSTOMER, SUPPLIER];
  env.features = { form1099: false };
  panel.open.mockReset();
  panel.sync.mockReset();
  env.createIntent.mockReset();
});

describe('ContactsPage', () => {
  it('lists every contact when no role is chosen', async () => {
    renderWithProviders(<ContactsPage />);
    expect(await screen.findByRole('button', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paper Co' })).toBeInTheDocument();
    expect(env.queryArgs).toMatchObject({ role: undefined });
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('');
  });

  it('opens a contact in the WeldBooks contact panel, synced to the Contacts list URL', async () => {
    renderWithProviders(<ContactsPage />);
    expect(panel.sync).toHaveBeenCalledWith('/weldbooks/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Paper Co' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_2' });
  });

  it('narrows to customers from ?role=customer, so the old customers link lands on the same list', () => {
    env.search = 'role=customer';
    renderWithProviders(<ContactsPage />);
    expect(env.queryArgs).toMatchObject({ role: 'customer' });
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('customer');
  });

  it('narrows to suppliers from ?role=supplier, named by the jurisdiction wording', () => {
    env.search = 'role=supplier';
    renderWithProviders(<ContactsPage />);
    expect(env.queryArgs).toMatchObject({ role: 'supplier' });
    expect(screen.getByRole('option', { name: 'Vendors' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All' })).toBeInTheDocument();
  });

  it('ignores a role it does not know and shows everyone', () => {
    env.search = 'role=nobody';
    renderWithProviders(<ContactsPage />);
    expect(env.queryArgs).toMatchObject({ role: undefined });
  });

  it('writes the chosen role to the address, keeping the panel stack, and clears it for All', async () => {
    env.search = 'stack=weldbooks_contact:prt_1';
    const user = userEvent.setup();
    renderWithProviders(<ContactsPage />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'supplier');
    const written = new URL(env.replace.mock.calls[0]![0] as string, 'http://x');
    expect(written.pathname).toBe('/weldbooks/contacts');
    expect(written.searchParams.get('role')).toBe('supplier');
    expect(written.searchParams.get('stack')).toBe('weldbooks_contact:prt_1');

    env.search = 'role=supplier';
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), '');
    const cleared = new URL(env.replace.mock.calls[1]![0] as string, 'http://x');
    expect(cleared.searchParams.has('role')).toBe(false);
  });

  it('shows each contact with its role in words', async () => {
    renderWithProviders(<ContactsPage />);
    expect(await screen.findByText('Customer')).toBeInTheDocument();
    expect(screen.getByText('Vendor')).toBeInTheDocument();
  });

  it('shows the vendor tax columns only for suppliers in a jurisdiction with 1099s', () => {
    env.features = { form1099: true };
    const { unmount } = renderWithProviders(<ContactsPage />);
    expect(screen.queryByText('1099')).not.toBeInTheDocument();
    unmount();

    env.search = 'role=supplier';
    renderWithProviders(<ContactsPage />);
    expect(screen.getAllByText(/1099/).length).toBeGreaterThan(0);
  });

  it('opens the new-contact popup from the palette\'s ?new=1', () => {
    renderWithProviders(<ContactsPage />);
    expect(env.createIntent).toHaveBeenCalledTimes(1);
    const open = env.createIntent.mock.calls[0]![0] as () => void;
    expect(typeof open).toBe('function');
  });
});
