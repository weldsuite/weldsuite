import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfDeclaration, HrSelfDeclarations } from '@weldsuite/app-api-client/domains/weldhr';

const t = en.weldhr.me.declarations;

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  download: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

let query: { data: HrSelfDeclarations | undefined; isLoading: boolean; error: Error | null };
let downloadPending = false;

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => path }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrDeclarations: () => ({ ...query, refetch: mocks.refetch }),
  useMyHrCancelDeclaration: () => ({ mutateAsync: mocks.cancel }),
}));
// The receipt download is the list's hook; this panel only calls it.
vi.mock('@/app/weldhr/me/components/declarations-tab', () => ({
  isWithdrawable: (d: { status: string }) => d.status === 'pending',
  useDownloadMyReceipt: () => ({ isPending: downloadPending, download: mocks.download }),
}));

import { MyDeclarationPanel } from './my-declaration-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

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

function setDeclarations(...declarations: HrSelfDeclaration[]) {
  query = { data: { declarations, open: [] }, isLoading: false, error: null };
}

function renderPanel(id = 'decl_1') {
  return renderWithProviders(<MyDeclarationPanel id={id} isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: en.sweep.entities.moreActions }));
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.cancel.mockResolvedValue(undefined);
  downloadPending = false;
  setDeclarations(declaration());
});

describe('MyDeclarationPanel', () => {
  it('shows a pending declaration with its details and dashes for what is not there yet', () => {
    renderPanel();
    // In the title, and as the Description row.
    expect(screen.getAllByText('Train to Utrecht')).toHaveLength(2);
    expect(screen.getByText(en.weldhr.declarations.category.travel)).toBeInTheDocument();
    expect(screen.getByText('€42.50')).toBeInTheDocument();
    expect(screen.getByText(t.panel.submittedOn)).toBeInTheDocument();
    expect(screen.getByText(t.panel.reviewedOn)).toBeInTheDocument();
    expect(screen.getByText(t.panel.reviewNote)).toBeInTheDocument();
    expect(screen.getByText(t.panel.paidOn)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'lunch.pdf' })).not.toBeInTheDocument();
  });

  it('shows the review and payout dates, the note and the receipt of a paid declaration', async () => {
    const user = userEvent.setup();
    setDeclarations(
      declaration({
        status: 'paid',
        hasReceipt: true,
        receiptFileName: 'ticket.pdf',
        reviewNote: 'Approved by HR',
        reviewedAt: '2026-10-14T09:00:00.000Z',
        paidAt: '2026-10-28T09:00:00.000Z',
      }),
    );
    renderPanel();
    expect(screen.getByText('Approved by HR')).toBeInTheDocument();
    expect(screen.getByText('14 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('28 Oct 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ticket.pdf' }));
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'decl_1' }));
  });

  it('names the receipt by its label when it has no file name, and disables it while downloading', () => {
    downloadPending = true;
    setDeclarations(declaration({ hasReceipt: true, receiptFileName: null }));
    renderPanel();
    expect(screen.getByRole('button', { name: t.list.table.receipt })).toBeDisabled();
  });

  it('offers download and withdraw in the menu of a pending declaration with a receipt', async () => {
    const user = userEvent.setup();
    setDeclarations(declaration({ hasReceipt: true, receiptFileName: 'ticket.pdf' }));
    renderPanel();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt }));
    expect(mocks.download).toHaveBeenCalled();
  });

  it('disables the download entry while a download runs', async () => {
    downloadPending = true;
    const user = userEvent.setup();
    setDeclarations(declaration({ hasReceipt: true, receiptFileName: 'ticket.pdf' }));
    renderPanel();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt })).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers neither download nor withdraw for a decided declaration without a receipt', async () => {
    const user = userEvent.setup();
    setDeclarations(declaration({ status: 'rejected' }));
    renderPanel();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: en.sweep.entities.copyLink })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: t.withdrawConfirm.confirm })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: en.weldhr.declarations.downloadReceipt })).not.toBeInTheDocument();
  });

  it('withdraws the declaration after confirming', async () => {
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t.withdrawConfirm.title)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.confirm }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('decl_1'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t.withdrawConfirm.toast);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('toasts the error when withdrawing fails, and closes the dialog', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('Already reviewed'));
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.confirm }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Already reviewed'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the declaration when the dialog is dismissed', async () => {
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: t.withdrawConfirm.confirm }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: t.withdrawConfirm.keep }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says the item is gone when it is not in the loaded list', () => {
    setDeclarations(declaration({ id: 'other' }));
    renderPanel();
    expect(screen.getByText(en.weldhr.me.panel.notFound)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.sweep.entities.moreActions })).not.toBeInTheDocument();
  });

  it('shows the load error with Retry when the list failed', async () => {
    const user = userEvent.setup();
    query = { data: undefined, isLoading: false, error: new Error('Server unavailable') };
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await user.click(screen.getByRole('button', { name: en.common.actions.retry }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows no body while loading', () => {
    query = { data: undefined, isLoading: true, error: null };
    renderPanel();
    expect(screen.queryByText(t.panel.submittedOn)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
