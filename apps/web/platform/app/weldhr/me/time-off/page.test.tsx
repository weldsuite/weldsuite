import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import MyTimeOffPage from './page';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), breadcrumbs: vi.fn() }));
let leaveRequests = true;

vi.mock('@/components/object-panel', () => ({ useObjectPanelUrlSync: (path: string) => mocks.sync(path) }));
vi.mock('../components/my-hr-page', () => ({ useMyHrBreadcrumbs: (label: string) => mocks.breadcrumbs(label) }));
vi.mock('../components/my-hr-context', () => ({ useMyHrSelf: () => ({ features: { leaveRequests } }) }));
vi.mock('../components/leave-tab', () => ({
  MyLeaveList: ({ canRequest }: { canRequest: boolean }) => <p>leave list can request {String(canRequest)}</p>,
}));
vi.mock('../components/leave-balances', () => ({ MyLeaveBalancesList: () => <p>balances list</p> }));
vi.mock('../components/sick-reports', () => ({ MySickReportsList: () => <p>sick list</p> }));

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyTimeOffPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.sync.mockReset();
  mocks.breadcrumbs.mockReset();
  leaveRequests = true;
});

describe('MyTimeOffPage', () => {
  it('starts on leave, sets the breadcrumb and syncs the panel with the URL', () => {
    renderPage();

    expect(screen.getByText('leave list can request true')).toBeInTheDocument();
    expect(screen.queryByText('balances list')).not.toBeInTheDocument();
    expect(mocks.breadcrumbs).toHaveBeenCalledWith('Time off');
    expect(mocks.sync).toHaveBeenCalledWith('/weldhr/me/time-off');
  });

  it('passes on that the workspace turned leave requests off', () => {
    leaveRequests = false;
    renderPage();

    expect(screen.getByText('leave list can request false')).toBeInTheDocument();
  });

  it('switches between the leave, balances and sick report tabs', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('tab', { name: 'Balances' }));
    expect(screen.getByText('balances list')).toBeInTheDocument();
    expect(screen.queryByText(/leave list/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Sick reports' }));
    expect(screen.getByText('sick list')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Leave' }));
    expect(screen.getByText(/leave list/)).toBeInTheDocument();
  });
});
