import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { ActiveFilter } from '@/components/panel-entity-list';

const t = en.weldhr.me.declarations;

const mocks = vi.hoisted(() => ({ urlSync: vi.fn(), breadcrumbs: vi.fn() }));
let features = { declarations: true };

vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: mocks.urlSync }));
vi.mock('../components/my-hr-context', () => ({ useMyHrSelf: () => ({ features }) }));
vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: mocks.breadcrumbs }));
vi.mock('../components/declaration-dialog', () => ({
  MyDeclarationDialog: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog">
      New declaration dialog
      <button type="button" onClick={onClose}>
        Close dialog
      </button>
    </div>
  ),
}));
vi.mock('../components/declarations-tab', () => ({
  MyDeclarationsList: ({
    canSubmit,
    onNewDeclaration,
    activeFilters,
  }: {
    canSubmit: boolean;
    onNewDeclaration: () => void;
    activeFilters: ActiveFilter[];
  }) => (
    <div>
      <p>declarations list, can submit: {String(canSubmit)}</p>
      <p>filters: {activeFilters.map((f) => `${f.field}=${f.value}`).join(',') || 'none'}</p>
      <button type="button" onClick={onNewDeclaration}>
        list new
      </button>
    </div>
  ),
}));
vi.mock('../components/payouts-tab', () => ({
  MyPayoutsList: ({ onOpenRow, onNewDeclaration }: { onOpenRow: (row: object) => void; onNewDeclaration?: () => void }) => (
    <div>
      <p>payouts list</p>
      <button type="button" onClick={() => onOpenRow({ kind: 'approved' })}>
        open approved
      </button>
      {onNewDeclaration && (
        <button type="button" onClick={onNewDeclaration}>
          payouts new
        </button>
      )}
    </div>
  ),
  payoutFilters: (row: { kind: string }) => [{ id: 'status', field: 'status', operator: 'is', value: row.kind }],
}));

import MyExpensesPage from './page';

function renderPage() {
  render(
    <I18nProvider initialLanguage="en">
      <MyExpensesPage />
    </I18nProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  features = { declarations: true };
});

describe('MyExpensesPage', () => {
  it('sets the breadcrumb, syncs the panel with the URL and opens on the declarations', () => {
    renderPage();
    expect(mocks.breadcrumbs).toHaveBeenCalledWith(en.weldhr.me.pages.expenses);
    expect(mocks.urlSync).toHaveBeenCalledWith('/weldhr/me/expenses');
    expect(screen.getByText(/declarations list, can submit: true/)).toBeInTheDocument();
    expect(screen.getByText('filters: none')).toBeInTheDocument();
    expect(screen.queryByText('payouts list')).not.toBeInTheDocument();
  });

  it('passes on that declarations are turned off', () => {
    features = { declarations: false };
    renderPage();
    expect(screen.getByText(/can submit: false/)).toBeInTheDocument();
  });

  it('opens the new-declaration dialog from the list, and closes it again', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('button', { name: 'list new' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog from the Payouts tab when declarations are on', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: t.tabs.payouts }));
    expect(screen.getByText('payouts list')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'payouts new' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('gives the Payouts tab no new-declaration action when declarations are off', async () => {
    features = { declarations: false };
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: t.tabs.payouts }));
    expect(screen.queryByRole('button', { name: 'payouts new' })).not.toBeInTheDocument();
  });

  it('opens the Declarations tab filtered on the payout row that was clicked', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: t.tabs.payouts }));
    await user.click(screen.getByRole('button', { name: 'open approved' }));
    expect(screen.getByText(/declarations list/)).toBeInTheDocument();
    expect(screen.getByText('filters: status=approved')).toBeInTheDocument();
    expect(screen.queryByText('payouts list')).not.toBeInTheDocument();
  });
});
