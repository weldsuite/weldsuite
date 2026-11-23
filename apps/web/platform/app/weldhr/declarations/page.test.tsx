import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';
import WeldHrDeclarationsPage from './page';
import { latest } from '@/components/panel-entity-list-test-mock';

const t = en.weldhr.declarations;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  data: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  receiptPending: false,
  markPaid: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  openReceipt: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@weldsuite/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div data-testid="tooltip">{children}</div>,
}));
vi.mock('./components/declaration-dialog', () => ({
  DeclarationDialog: (p: { declaration?: { id: string }; onClose: () => void }) => (
    <button onClick={p.onClose}>{p.declaration ? `edit dialog ${p.declaration.id}` : 'create dialog'}</button>
  ),
}));
vi.mock('./components/review-dialog', () => ({
  DeclarationReviewDialog: (p: { declaration: { id: string }; decision: string; onClose: () => void }) => (
    <button onClick={p.onClose}>{`review ${p.declaration.id} ${p.decision}`}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrDeclarations: () => ({ data: state.data, isLoading: state.isLoading, error: state.error }),
  useMarkHrDeclarationPaid: () => ({ mutateAsync: state.markPaid }),
  useCancelHrDeclaration: () => ({ mutateAsync: state.cancel }),
  useDeleteHrDeclaration: () => ({ mutateAsync: state.remove }),
  useOpenHrDeclarationReceipt: () => ({ mutate: state.openReceipt, isPending: state.receiptPending }),
}));

function declaration(over: Partial<HrDeclarationListItem> & { id: string }): HrDeclarationListItem {
  return {
    employeeId: 'emp_1',
    employeeName: 'Anna de Vries',
    expenseDate: '2026-11-10',
    category: 'travel',
    description: 'Train to Utrecht',
    amount: 42.5,
    currency: 'EUR',
    status: 'pending',
    hasReceipt: false,
    receiptFileName: null,
    receiptContentType: null,
    receiptSize: null,
    submittedBy: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    paidBy: null,
    paidAt: null,
    createdAt: '2026-11-10T10:00:00Z',
    updatedAt: '2026-11-10T10:00:00Z',
    ...over,
  };
}

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <WeldHrDeclarationsPage />
    </I18nProvider>,
  );
}

const ALL = ['declarations:create', 'declarations:approve', 'declarations:update', 'declarations:delete'];

beforeEach(() => {
  state.permissions = new Set(ALL);
  state.isLoading = false;
  state.error = null;
  state.receiptPending = false;
  for (const fn of [state.markPaid, state.cancel, state.remove]) fn.mockReset().mockResolvedValue(undefined);
  state.openReceipt.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
  state.data = [
    declaration({ id: 'd_pending', hasReceipt: true, receiptFileName: 'ticket.pdf' }),
    declaration({ id: 'd_approved', employeeName: 'Bram Jansen', category: 'meals', status: 'approved', hasReceipt: true }),
    declaration({ id: 'd_paid', employeeName: 'Carla Smit', category: 'equipment', status: 'paid' }),
    declaration({ id: 'd_rejected', employeeName: 'Dirk Visser', category: 'training', status: 'rejected' }),
    declaration({ id: 'd_cancelled', employeeName: 'Emma Bakker', category: 'other', status: 'cancelled' }),
  ];
});

describe('WeldHrDeclarationsPage', () => {
  it('groups the declarations by status', () => {
    renderPage();
    expect(within(screen.getByRole('region', { name: t.groups.pending })).getByTestId('row-d_pending')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: t.groups.approved })).getByTestId('row-d_approved')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: t.groups.paid })).getByTestId('row-d_paid')).toBeInTheDocument();
    const closed = within(screen.getByRole('region', { name: t.groups.rejectedCancelled }));
    expect(closed.getByTestId('row-d_rejected')).toBeInTheDocument();
    expect(closed.getByTestId('row-d_cancelled')).toBeInTheDocument();
  });

  it('puts an unknown status in Other', () => {
    state.data = [declaration({ id: 'd_odd', status: 'archived' as HrDeclarationListItem['status'] })];
    renderPage();
    expect(within(screen.getByRole('region', { name: t.groups.other })).getByTestId('row-d_odd')).toBeInTheDocument();
  });

  it('shows the category with the description on hover, the amount and the date', () => {
    renderPage();
    const row = within(screen.getByTestId('row-d_pending'));
    const category = row.getByText(t.category.travel);
    expect(category).toHaveAttribute('title', 'Train to Utrecht');
    expect(row.getByText(/42[.,]50/)).toBeInTheDocument();
    expect(row.getByText(/10 Nov 2026/)).toBeInTheDocument();
  });

  it('shows the loading state, the error and the empty state', () => {
    state.isLoading = true;
    const first = renderPage();
    expect(screen.getByText('loading')).toBeInTheDocument();
    first.unmount();

    state.isLoading = false;
    state.error = new Error('Server down');
    const second = renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    second.unmount();

    state.error = null;
    state.data = undefined;
    renderPage();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
  });

  it('searches by employee and description', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('search'), 'bram');
    expect(screen.getByTestId('row-d_approved')).toBeInTheDocument();
    expect(screen.queryByTestId('row-d_pending')).not.toBeInTheDocument();
  });

  it('filters by status, category and employee', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'status=paid' }));
    expect(screen.getByTestId('row-d_paid')).toBeInTheDocument();
    expect(screen.queryByTestId('row-d_pending')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'category=meals' }));
    expect(screen.getByTestId('row-d_approved')).toBeInTheDocument();
    expect(screen.queryByTestId('row-d_paid')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'employee=Anna de Vries' }));
    expect(screen.getByTestId('row-d_pending')).toBeInTheDocument();
    expect(screen.queryByTestId('row-d_approved')).not.toBeInTheDocument();
  });

  it('lists each employee once as a filter option', () => {
    state.data = [declaration({ id: 'a' }), declaration({ id: 'b' }), declaration({ id: 'c', employeeName: 'Bram Jansen' })];
    renderPage();
    expect(
      within(screen.getByRole('group', { name: 'filter employee' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['employee=Anna de Vries', 'employee=Bram Jansen']);
  });

  describe('receipt', () => {
    it('shows a dash without a receipt and a download button with one', () => {
      renderPage();
      expect(within(screen.getByTestId('row-d_paid')).queryByRole('button', { name: new RegExp(t.downloadReceipt) })).not.toBeInTheDocument();
      expect(within(screen.getByTestId('row-d_pending')).getByRole('button', { name: `${t.downloadReceipt}: ticket.pdf` })).toBeInTheDocument();
      // Without a file name the label is just the action, and the tooltip has no name line.
      expect(within(screen.getByTestId('row-d_approved')).getByRole('button', { name: t.downloadReceipt })).toBeInTheDocument();
      expect(within(screen.getByTestId('row-d_pending')).getByText('ticket.pdf', { selector: 'p' })).toBeInTheDocument();
    });

    it('opens the receipt', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: `${t.downloadReceipt}: ticket.pdf` }));
      expect(state.openReceipt).toHaveBeenCalledTimes(1);
      expect(state.openReceipt.mock.calls[0]![0]).toMatchObject({ id: 'd_pending' });
    });

    it('shows the error when the receipt cannot be opened', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: `${t.downloadReceipt}: ticket.pdf` }));
      const options = state.openReceipt.mock.calls[0]![1] as { onError: (err: unknown) => void };
      options.onError(new Error('Gone'));
      expect(toast.error).toHaveBeenCalledWith('Gone');
      options.onError('x');
      expect(toast.error).toHaveBeenCalledWith(t.receiptFailed);
    });

    it('disables the download while one is opening', () => {
      state.receiptPending = true;
      renderPage();
      expect(screen.getByRole('button', { name: `${t.downloadReceipt}: ticket.pdf` })).toBeDisabled();
    });
  });

  describe('row actions', () => {
    it('approves or rejects a pending declaration', async () => {
      const user = userEvent.setup();
      renderPage();
      const row = within(screen.getByTestId('row-d_pending'));
      await user.click(row.getByRole('button', { name: t.approve }));
      await user.click(screen.getByRole('button', { name: 'review d_pending approved' }));
      expect(screen.queryByRole('button', { name: /^review / })).not.toBeInTheDocument();
      await user.click(row.getByRole('button', { name: t.reject }));
      expect(screen.getByRole('button', { name: 'review d_pending rejected' })).toBeInTheDocument();
    });

    it('offers Mark as paid only for an approved declaration', () => {
      renderPage();
      expect(within(screen.getByTestId('row-d_approved')).getByRole('button', { name: t.markPaid })).toBeInTheDocument();
      expect(within(screen.getByTestId('row-d_pending')).queryByRole('button', { name: t.markPaid })).not.toBeInTheDocument();
    });

    it('offers Cancel for pending and approved declarations only', () => {
      renderPage();
      expect(within(screen.getByTestId('row-d_pending')).getByRole('button', { name: t.cancel })).toBeInTheDocument();
      expect(within(screen.getByTestId('row-d_approved')).getByRole('button', { name: t.cancel })).toBeInTheDocument();
      expect(within(screen.getByTestId('row-d_paid')).queryByRole('button', { name: t.cancel })).not.toBeInTheDocument();
    });

    it('marks a declaration as paid after confirming, naming the amount and employee', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(within(screen.getByTestId('row-d_approved')).getByRole('button', { name: t.markPaid }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/for Bram Jansen is recorded as reimbursed/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t.markPaid }));
      await waitFor(() => expect(state.markPaid).toHaveBeenCalledWith('d_approved'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('shows the error when marking as paid fails', async () => {
      state.markPaid.mockRejectedValue(new Error('Locked'));
      const user = userEvent.setup();
      renderPage();
      await user.click(within(screen.getByTestId('row-d_approved')).getByRole('button', { name: t.markPaid }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.markPaid }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Locked'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('cancels a declaration after confirming', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(within(screen.getByTestId('row-d_pending')).getByRole('button', { name: t.cancel }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.cancelConfirmTitle)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(state.cancel).toHaveBeenCalledWith('d_pending'));
    });

    it('shows the error when cancelling fails', async () => {
      state.cancel.mockRejectedValue('no');
      const user = userEvent.setup();
      renderPage();
      await user.click(within(screen.getByTestId('row-d_pending')).getByRole('button', { name: t.cancel }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.cancelFailed));
    });

    it('hides the review, pay and cancel actions without the permissions', () => {
      state.permissions = new Set();
      renderPage();
      expect(screen.queryByRole('button', { name: t.approve })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.markPaid })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.cancel })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.newDeclaration })).not.toBeInTheDocument();
    });
  });

  describe('create, edit and delete', () => {
    it('creates a declaration', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: t.newDeclaration }));
      await user.click(screen.getByRole('button', { name: 'create dialog' }));
      expect(screen.queryByRole('button', { name: 'create dialog' })).not.toBeInTheDocument();
    });

    it('edits a pending declaration', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'edit d_pending' }));
      await user.click(screen.getByRole('button', { name: 'edit dialog d_pending' }));
      expect(screen.queryByRole('button', { name: /^edit dialog/ })).not.toBeInTheDocument();
    });

    it('tells the user a declaration past pending cannot be edited', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'edit d_approved' }));
      expect(toast.info).toHaveBeenCalledWith(t.editLocked);
      expect(screen.queryByRole('button', { name: /^edit dialog/ })).not.toBeInTheDocument();
    });

    it('deletes after confirming and reports a failure', async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(screen.getByRole('button', { name: 'delete d_paid' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('d_paid'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      state.remove.mockRejectedValue(new Error('In use'));
      await user.click(screen.getByRole('button', { name: 'delete d_paid' }));
      dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('In use'));
    });

    it('has no edit and delete without the permissions', () => {
      state.permissions = new Set();
      renderPage();
      expect(screen.queryByRole('button', { name: 'edit d_pending' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'delete d_pending' })).not.toBeInTheDocument();
    });
  });

  it('leaves the rows alone for a filter without a value or on an unknown field', () => {
    renderPage();
    const rows = state.data as unknown[] as never[];
    expect(latest.applyFilters?.(rows, [{ id: 'a', field: 'status', operator: 'is', value: '' }])).toHaveLength(rows.length);
    expect(latest.applyFilters?.(rows, [{ id: 'b', field: 'unknown', operator: 'is', value: 'x' }])).toHaveLength(rows.length);
  });
});
