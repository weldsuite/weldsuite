import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrLeaveBalance, HrSelfLeave, HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';

const mocks = vi.hoisted(() => ({ refetch: vi.fn() }));
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';
let leave: HrSelfLeave;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrLeave: () => ({
    data: queryState === 'loaded' ? leave : undefined,
    isLoading: queryState === 'loading',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch: mocks.refetch,
  }),
}));

import { en } from '@weldsuite/i18n/locales/en';
import { MyLeaveBalancePanel } from './my-leave-balance-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeBalance(extra: Partial<HrLeaveBalance> = {}): HrLeaveBalance {
  return {
    leaveTypeId: 'type_1',
    name: 'Holiday',
    color: '#00ff00',
    isPaid: true,
    overAllowance: 'block',
    allowance: 25,
    fullAllowance: 25,
    prorated: false,
    used: 4,
    pending: 2,
    remaining: 19,
    ...extra,
  };
}

function makeRequest(extra: Partial<HrSelfLeaveRequest> = {}): HrSelfLeaveRequest {
  return {
    id: 'req_1',
    leaveTypeId: 'type_1',
    leaveTypeName: 'Holiday',
    leaveTypeColor: null,
    startDate: '2026-07-01',
    endDate: '2026-07-05',
    days: 5,
    reason: null,
    status: 'approved',
    reviewNote: null,
    reviewedAt: null,
    ...extra,
  };
}

function renderPanel(props: { id?: string; initialTab?: string } = {}) {
  return renderWithProviders(
    <MyLeaveBalancePanel id={props.id ?? 'type_1'} initialTab={props.initialTab} isOpen onClose={() => {}} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState = 'loaded';
  leave = { types: [], balances: [makeBalance()], requests: [makeRequest()] };
});

describe('MyLeaveBalancePanel', () => {
  it('shows the allowance, use and what is left', () => {
    renderPanel();
    expect(screen.getAllByText('Holiday').length).toBeGreaterThan(0);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('19')).toBeInTheDocument();
    expect(screen.queryByText('Full allowance')).not.toBeInTheDocument();
  });

  it('shows the full allowance of a prorated balance', () => {
    leave.balances = [
      makeBalance({
        prorated: true,
        allowance: 12.5,
        fullAllowance: 25,
        isPaid: false,
      }),
    ];
    renderPanel();
    expect(screen.getByText('12.5')).toBeInTheDocument();
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('shows an unlimited balance without the over-allowance row', () => {
    leave.balances = [makeBalance({ allowance: null, fullAllowance: null, remaining: null })];
    renderPanel();
    expect(screen.getAllByText('Unlimited').length).toBeGreaterThanOrEqual(2);
  });

  it('counts the requests on the tab and lists them, each opening its own panel', async () => {
    const user = userEvent.setup();
    leave.requests = [
      makeRequest(),
      makeRequest({ id: 'req_2', status: 'pending' }),
      makeRequest({ id: 'req_other', leaveTypeId: 'type_2' }),
    ];
    renderPanel();
    const tab = screen.getByRole('tab', { name: /requests/i });
    expect(tab).toHaveTextContent('Requests');
    await user.click(tab);
    const rows = screen.getAllByRole('button', { name: /–/ });
    expect(rows.length).toBe(2);
    await user.click(rows[0]);
    expect(panelOpen).toHaveBeenCalledWith({
      type: 'hr_my_leave_request',
      id: 'req_1',
      stack: true,
    });
  });

  it('opens on the requests tab from a deep link and shows the empty state', () => {
    leave.requests = [];
    renderPanel({ initialTab: 'requests' });
    expect(screen.getByRole('tab', { name: /requests/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(en.weldhr.me.timeOff.panel.noRequests.title)).toBeInTheDocument();
  });

  it('has no actions and says so while the balance is unknown', () => {
    renderPanel({ id: 'type_unknown' });
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('shows the error with Try again when the list failed', async () => {
    queryState = 'failed';
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows no content while loading', () => {
    queryState = 'loading';
    renderPanel();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });
});
