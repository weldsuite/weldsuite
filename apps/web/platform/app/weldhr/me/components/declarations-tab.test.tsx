import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfDeclaration, HrSelfDeclarations } from '@weldsuite/app-api-client/domains/weldhr';
import type { ActiveFilter } from '@/components/panel-entity-list';

const t = en.weldhr.me.declarations;

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  openReceipt: vi.fn(),
  open: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

let state: { data: HrSelfDeclarations | undefined; isLoading: boolean; error: Error | null };
let receiptPending = false;

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  useObjectPanel: () => ({ open: mocks.open }),
  useObjectPanelNavigationReporter: () => () => {},
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrDeclarations: () => state,
  useMyHrCancelDeclaration: () => ({ mutateAsync: mocks.cancel }),
  useMyHrOpenDeclarationReceipt: () => ({ mutate: mocks.openReceipt, isPending: receiptPending }),
}));

import { MyDeclarationsList, filterDeclarations, isWithdrawable, paidMonthOf } from './declarations-tab';

function declaration(extra: Partial<HrSelfDeclaration> = {}): HrSelfDeclaration {
  return {
    id: 'decl_1',
    expenseDate: '2026-10-12',
    category: 'travel',
    description: 'Train to Utrecht',
    amount: 42.5,
    currency: 'EUR',
    status: 'pending',
    hasReceipt: false,
    receiptFileName: null,
    reviewNote: null,
    reviewedAt: null,
    paidAt: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    ...extra,
  };
}

const rows: HrSelfDeclaration[] = [
  declaration(),
  declaration({
    id: 'decl_2',
    description: 'Team lunch',
    category: 'meals',
    amount: 60,
    status: 'approved',
    hasReceipt: true,
    receiptFileName: 'lunch.pdf',
    reviewedAt: '2026-10-14T09:00:00.000Z',
  }),
  declaration({
    id: 'decl_3',
    description: 'Hotel in Berlin',
    category: 'accommodation',
    amount: 180,
    status: 'paid',
    reviewNote: 'Fine',
    paidAt: '2026-09-20T10:00:00.000Z',
  }),
  declaration({ id: 'decl_4', description: 'Laptop stand', category: 'equipment', status: 'rejected', reviewNote: 'Not covered' }),
  declaration({ id: 'decl_5', description: 'Old course', category: 'training', status: 'cancelled' }),
  declaration({ id: 'decl_6', description: 'Mystery', status: 'on_hold' as HrSelfDeclaration['status'] }),
];

const paidFilter: ActiveFilter = { id: 'status', field: 'status', operator: 'is', value: 'paid' };

function Harness(props: Readonly<{ canSubmit?: boolean; onNew?: () => void; initial?: ActiveFilter[] }>) {
  const [filters, setFilters] = useState<ActiveFilter[]>(props.initial ?? []);
  return (
    <I18nProvider initialLanguage="en">
      <MyDeclarationsList
        canSubmit={props.canSubmit ?? true}
        onNewDeclaration={props.onNew ?? vi.fn()}
        activeFilters={filters}
        onFiltersChange={setFilters}
      />
    </I18nProvider>
  );
}

function setData(declarations: HrSelfDeclaration[], open: HrSelfDeclarations['open'] = []) {
  state = { data: { declarations, open }, isLoading: false, error: null };
}

function rowOf(description: string): HTMLElement {
  const row = screen.getByText(description).closest('div.group');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

/** The "⋮" button of the row that shows this description. */
function menuButtonOf(description: string): HTMLElement | undefined {
  let node: HTMLElement | null = screen.getByText(description);
  while (node && node !== document.body) {
    const button = Array.from(node.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-ellipsis-vertical'));
    if (button) return button;
    node = node.parentElement;
  }
  return undefined;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, description: string) {
  const button = menuButtonOf(description);
  expect(button).toBeDefined();
  await user.click(button as HTMLElement);
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.cancel.mockResolvedValue(undefined);
  receiptPending = false;
  setData(rows, [
    { currency: 'EUR', pending: 42.5, approved: 60 },
    { currency: 'USD', pending: 0, approved: 10 },
  ]);
});

describe('helpers', () => {
  it('finds the month a paid declaration was paid in, falling back to review and creation dates', () => {
    expect(paidMonthOf(declaration())).toBeNull();
    expect(paidMonthOf(declaration({ status: 'paid', paidAt: '2026-09-20T10:00:00' }))).toBe('2026-09');
    expect(paidMonthOf(declaration({ status: 'paid', reviewedAt: '2026-08-02T10:00:00' }))).toBe('2026-08');
    expect(paidMonthOf(declaration({ status: 'paid', createdAt: '2026-07-02T10:00:00' }))).toBe('2026-07');
  });

  it('narrows by status, category and paid month, and ignores empty or unknown filters', () => {
    const f = (field: string, value: string): ActiveFilter => ({ id: field, field, operator: 'is', value });
    expect(filterDeclarations(rows, [f('status', 'approved')]).map((d) => d.id)).toEqual(['decl_2']);
    expect(filterDeclarations(rows, [f('category', 'meals')]).map((d) => d.id)).toEqual(['decl_2']);
    expect(filterDeclarations(rows, [f('paidMonth', '2026-09')]).map((d) => d.id)).toEqual(['decl_3']);
    expect(filterDeclarations(rows, [f('status', '')])).toHaveLength(rows.length);
    expect(filterDeclarations(rows, [f('other', 'x')])).toHaveLength(rows.length);
  });

  it('lets only a pending declaration be withdrawn', () => {
    expect(isWithdrawable(declaration())).toBe(true);
    expect(isWithdrawable(declaration({ status: 'approved' }))).toBe(false);
  });
});

describe('MyDeclarationsList', () => {
  it('groups the declarations by status and shows the open amounts per currency on the headers', () => {
    render(<Harness />);
    expect(screen.getByText('Train to Utrecht')).toBeInTheDocument();
    expect(screen.getByText('Team lunch')).toBeInTheDocument();
    expect(screen.getByText('Hotel in Berlin')).toBeInTheDocument();
    expect(screen.getByText('Laptop stand')).toBeInTheDocument();
    expect(screen.getByText('Mystery')).toBeInTheDocument();
    expect(screen.getAllByText('€42.50').length).toBeGreaterThan(0);
    expect(screen.getByText(/€60\.00 · .*10\.00/)).toBeInTheDocument();
  });

  it('shows no open amount on a header when nothing is open', () => {
    setData(rows, []);
    render(<Harness />);
    expect(screen.queryByText(/€60\.00 · /)).not.toBeInTheDocument();
  });

  it('shows the receipt sign only for a declaration with a receipt', () => {
    render(<Harness />);
    expect(screen.getAllByLabelText(t.list.table.receipt)).toHaveLength(1);
  });

  it('opens the declaration panel on a row click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(within(rowOf('Team lunch')).getByRole('button', { name: en.common.actions.view }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'decl_2' }));
  });

  it('searches the description and the review note', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getAllByPlaceholderText(t.list.searchPlaceholder)[0];
    await user.type(search, 'berlin');
    expect(screen.getByText('Hotel in Berlin')).toBeInTheDocument();
    expect(screen.queryByText('Team lunch')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'not covered');
    expect(screen.getByText('Laptop stand')).toBeInTheDocument();
    expect(screen.queryByText('Hotel in Berlin')).not.toBeInTheDocument();
  });

  it('shows the rows the page filters leave', () => {
    render(<Harness initial={[paidFilter]} />);
    expect(screen.getByText('Hotel in Berlin')).toBeInTheDocument();
    expect(screen.queryByText('Team lunch')).not.toBeInTheDocument();
  });

  it('shows the no-results state when the filters leave nothing', () => {
    setData([declaration()]);
    render(<Harness initial={[paidFilter]} />);
    expect(screen.getByText(t.list.noResults.title)).toBeInTheDocument();
  });

  it('offers a paid-month filter when something was paid', async () => {
    const user = userEvent.setup();
    setData([
      declaration({ id: 'a', status: 'paid', paidAt: '2026-08-10T10:00:00' }),
      declaration({ id: 'b', status: 'paid', paidAt: '2026-10-10T10:00:00' }),
      declaration({ id: 'c', status: 'paid', paidAt: '2026-10-11T10:00:00' }),
    ]);
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /filter/i }));
    expect(await screen.findByText(t.list.filters.paidMonth)).toBeInTheDocument();
  });

  it('shows the empty state with the new-declaration button when declarations are allowed', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    setData([]);
    render(<Harness onNew={onNew} />);
    expect(screen.getByText(t.list.empty)).toBeInTheDocument();
    expect(screen.getByText(t.list.emptyHint)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: t.newDeclaration })[0]);
    expect(onNew).toHaveBeenCalled();
  });

  it('says why there is no button when the workspace turned declarations off', () => {
    setData([]);
    render(<Harness canSubmit={false} />);
    expect(screen.getByText(t.submitOff)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.newDeclaration })).not.toBeInTheDocument();
  });

  it('shows no rows while loading, and the error when the list failed', () => {
    state = { data: undefined, isLoading: true, error: null };
    const { unmount } = render(<Harness />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Train to Utrecht')).not.toBeInTheDocument();
    unmount();
    state = { data: undefined, isLoading: false, error: new Error('Server unavailable') };
    render(<Harness />);
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
  });

  it('keeps the rows on screen when a refetch failed but data is there', () => {
    state = { data: { declarations: rows, open: [] }, isLoading: false, error: new Error('Refetch failed') };
    render(<Harness />);
    expect(screen.getByText('Train to Utrecht')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load data')).not.toBeInTheDocument();
  });

  describe('row menu', () => {
    it('downloads the receipt of a declaration that has one', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Team lunch');
      await user.click(await screen.findByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt }));
      expect(mocks.openReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: 'decl_2' }), expect.any(Object));
    });

    it('toasts when the receipt could not be downloaded', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Team lunch');
      await user.click(await screen.findByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt }));
      const options = mocks.openReceipt.mock.calls[0][1] as { onError: (err: unknown) => void };
      options.onError(new Error('Gone'));
      expect(mocks.toastError).toHaveBeenCalledWith('Gone');
      options.onError('nope');
      expect(mocks.toastError).toHaveBeenLastCalledWith(t.list.receiptFailed);
    });

    it('disables the receipt entry while a download runs', async () => {
      receiptPending = true;
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Team lunch');
      expect(await screen.findByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('withdraws a pending declaration after confirming', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Train to Utrecht');
      await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.withdrawConfirm.title)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.confirm }));
      await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('decl_1'));
      expect(mocks.toastSuccess).toHaveBeenCalledWith(t.withdrawConfirm.toast);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('toasts the failure when withdrawing fails, and closes the dialog', async () => {
      mocks.cancel.mockRejectedValue(new Error('Already reviewed'));
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Train to Utrecht');
      await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.confirm }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Already reviewed'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('keeps the declaration when the withdraw dialog is dismissed', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await openMenu(user, 'Train to Utrecht');
      await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.keep }));
      expect(mocks.cancel).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('has no menu for a declaration without a receipt that cannot be withdrawn', () => {
      setData([declaration({ id: 'x', description: 'Done deal', status: 'paid', paidAt: '2026-09-20T10:00:00' })]);
      render(<Harness />);
      expect(menuButtonOf('Done deal')).toBeUndefined();
    });
  });
});
