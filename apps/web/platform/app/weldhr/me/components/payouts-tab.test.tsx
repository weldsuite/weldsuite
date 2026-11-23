import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfDeclaration, HrSelfDeclarations } from '@weldsuite/app-api-client/domains/weldhr';

const t = en.weldhr.me.declarations;

let state: { data: HrSelfDeclarations | undefined; isLoading: boolean; error: Error | null };

vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  useObjectPanelNavigationReporter: () => () => {},
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrDeclarations: () => state,
}));

import { MyPayoutsList, payoutFilters, payoutRows } from './payouts-tab';

function declaration(extra: Partial<HrSelfDeclaration> = {}): HrSelfDeclaration {
  return {
    id: 'decl_1',
    expenseDate: '2026-10-12',
    category: 'travel',
    description: 'Train to Utrecht',
    amount: 10.1,
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

const declarations: HrSelfDeclaration[] = [
  declaration({ id: 'a', amount: 10.1 }),
  declaration({ id: 'b', amount: 0.2 }),
  declaration({ id: 'c', status: 'approved', amount: 60 }),
  declaration({ id: 'd', status: 'approved', amount: 5, currency: 'USD' }),
  declaration({ id: 'e', status: 'paid', amount: 180, paidAt: '2026-09-20T10:00:00' }),
  declaration({ id: 'f', status: 'paid', amount: 20, paidAt: '2026-09-02T10:00:00' }),
  declaration({ id: 'g', status: 'paid', amount: 7, paidAt: '2025-12-15T10:00:00' }),
  declaration({ id: 'h', status: 'rejected' }),
];

function setData(list: HrSelfDeclaration[]) {
  state = { data: { declarations: list, open: [] }, isLoading: false, error: null };
}

function renderList(props: { onOpenRow?: () => void; onNew?: () => void } = {}) {
  return render(
    <I18nProvider initialLanguage="en">
      <MyPayoutsList onOpenRow={props.onOpenRow ?? vi.fn()} onNewDeclaration={props.onNew} />
    </I18nProvider>,
  );
}

beforeEach(() => setData(declarations));

describe('payoutRows', () => {
  it('always starts with the two outstanding rows, then one row per paid month, newest first', () => {
    const rows = payoutRows(declarations);
    expect(rows.map((r) => r.id)).toEqual(['pending', 'approved', 'paid:2026-09', 'paid:2025-12']);
  });

  it('counts per row and sums per currency in cents, without floating-point dust', () => {
    const [pending, approved, september] = payoutRows(declarations);
    expect(pending.count).toBe(2);
    expect(pending.amounts.get('EUR')).toBe(1030);
    expect(approved.count).toBe(2);
    expect(approved.amounts.get('USD')).toBe(500);
    expect(september.count).toBe(2);
    expect(september.amounts.get('EUR')).toBe(20000);
  });

  it('leaves out rejected and cancelled declarations, and keeps empty outstanding rows', () => {
    const rows = payoutRows([declaration({ status: 'cancelled' })]);
    expect(rows.map((r) => r.id)).toEqual(['pending', 'approved']);
    expect(rows.every((r) => r.count === 0)).toBe(true);
  });
});

describe('payoutFilters', () => {
  it('filters the declarations by paid month for a paid row, and by status otherwise', () => {
    const [pending, , paid] = payoutRows(declarations);
    expect(payoutFilters(paid)).toEqual([{ id: 'paidMonth', field: 'paidMonth', operator: 'is', value: '2026-09' }]);
    expect(payoutFilters(pending)).toEqual([{ id: 'status', field: 'status', operator: 'is', value: 'pending' }]);
  });

  it('falls back to an empty month for a paid row without one', () => {
    const [pending] = payoutRows(declarations);
    expect(payoutFilters({ ...pending, kind: 'paid', month: null })[0].value).toBe('');
  });
});

describe('MyPayoutsList', () => {
  it('shows the outstanding rows and a row per payout month with count and amounts', () => {
    renderList();
    expect(screen.getByText(t.groups.pending)).toBeInTheDocument();
    expect(screen.getByText(t.groups.approved)).toBeInTheDocument();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('December 2025')).toBeInTheDocument();
    expect(screen.getAllByText('€10.30').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/€60\.00 · .*5\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('€200.00').length).toBeGreaterThan(0);
  });

  it('puts a dash on an outstanding row with nothing to come, and no total on a group without amounts', () => {
    setData([declaration({ id: 'p', status: 'paid', paidAt: '2026-09-20T10:00:00', amount: 12 })]);
    renderList();
    expect(screen.getAllByText('—').length).toBe(2);
    expect(screen.getAllByText('€12.00').length).toBeGreaterThan(0);
  });

  it('opens the declarations behind the row that was clicked', async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    renderList({ onOpenRow });
    const row = screen.getByText('September 2026').closest('div.group') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: en.common.actions.view }));
    expect(onOpenRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'paid:2026-09', kind: 'paid', month: '2026-09', count: 2 }));
  });

  it('searches the rows by their name', async () => {
    const user = userEvent.setup();
    renderList();
    await user.type(screen.getAllByPlaceholderText(t.payouts.searchPlaceholder)[0], 'dec');
    expect(screen.getByText('December 2025')).toBeInTheDocument();
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument();
  });

  it('offers the status and year filters and narrows the rows by them', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: /filter/i }));
    await user.click(await screen.findByText(t.payouts.filters.year));
    await user.click(await screen.findByText('2025'));
    expect(screen.getByText('December 2025')).toBeInTheDocument();
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument();
    expect(screen.queryByText(t.groups.pending)).not.toBeInTheDocument();
  });

  it('narrows to one kind with the status filter', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: /filter/i }));
    await user.click(await screen.findByText(t.payouts.filters.status));
    const options = await screen.findAllByText(t.groups.approved);
    await user.click(options[options.length - 1]);
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument();
    expect(screen.queryByText(t.groups.pending)).not.toBeInTheDocument();
  });

  it('shows the empty state with the new-declaration button when declarations are allowed', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    setData([]);
    renderList({ onNew });
    expect(screen.getByText(t.payouts.empty.title)).toBeInTheDocument();
    expect(screen.getByText(t.payouts.empty.description)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: t.newDeclaration })[0]);
    expect(onNew).toHaveBeenCalled();
  });

  it('has no new-declaration button when the workspace turned declarations off', () => {
    setData([]);
    renderList();
    expect(screen.queryByRole('button', { name: t.newDeclaration })).not.toBeInTheDocument();
  });

  it('shows a loader while loading, and the error when the list failed', () => {
    state = { data: undefined, isLoading: true, error: null };
    const { unmount } = renderList();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    unmount();
    state = { data: undefined, isLoading: false, error: new Error('Server unavailable') };
    renderList();
    expect(screen.getByText('Failed to load data')).toBeInTheDocument();
  });

  it('keeps the rows when a refetch failed but data is there', () => {
    state = { data: { declarations, open: [] }, isLoading: false, error: new Error('Refetch failed') };
    renderList();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });
});
