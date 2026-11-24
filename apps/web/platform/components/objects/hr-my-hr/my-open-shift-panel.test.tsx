import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), withdraw: vi.fn() }));
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';
let shifts: HrSelfOpenShift[];

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrOpenShifts: () => ({
    data: queryState === 'loaded' ? shifts : undefined,
    isLoading: queryState === 'loading',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch: mocks.refetch,
  }),
}));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
// The sign-up pieces have tests of their own; here they only show what the panel hands them.
vi.mock('@/app/weldhr/me/components/open-shifts-card', () => ({
  activeRequest: (shift: HrSelfOpenShift) =>
    shift.myRequest && shift.myRequest.status !== 'cancelled' ? shift.myRequest : null,
  useSpotsLabel: () => (spotsLeft: number) => `${spotsLeft} left`,
  useWithdrawSignUp: () => ({ isPending: false, withdraw: mocks.withdraw }),
  SignUpBadge: ({ shift }: { shift: HrSelfOpenShift }) => <span>{`Badge ${shift.myRequest?.status ?? 'none'}`}</span>,
  OpenShiftMenuItems: ({
    onSignUp,
    onWithdraw,
  }: {
    onSignUp: () => void;
    onWithdraw: (id: string) => void;
    withdrawing: boolean;
  }) => (
    <>
      <DropdownMenuItem onClick={onSignUp}>
        Sign up here
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onWithdraw('request_1')}>
        Withdraw here
      </DropdownMenuItem>
    </>
  ),
  SignUpDialog: ({ shift, onClose }: { shift: { id: string }; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`Dialog for ${shift.id}`}
    </button>
  ),
}));

import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { MyOpenShiftPanel } from './my-open-shift-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeShift(extra: Partial<HrSelfOpenShift> = {}): HrSelfOpenShift {
  return {
    id: 'open_1',
    startsAt: '2026-06-01T08:00:00',
    endsAt: '2026-06-01T16:30:00',
    workType: 'Cashier',
    breakStartsAt: '2026-06-01T12:00:00',
    breakEndsAt: '2026-06-01T12:30:00',
    notes: 'Bring the keys',
    companyName: 'Acme BV',
    departmentName: 'Front of house',
    spots: 3,
    spotsLeft: 2,
    myRequest: null,
    ...extra,
  };
}

function renderPanel() {
  return renderWithProviders(<MyOpenShiftPanel id="open_1" isOpen onClose={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState = 'loaded';
  shifts = [makeShift()];
});

describe('MyOpenShiftPanel', () => {
  it('shows the open shift with its times, break, client, department and spots', () => {
    renderPanel();
    expect(screen.getAllByText('Cashier').length).toBeGreaterThan(0);
    expect(screen.getByText('08:00 – 16:30')).toBeInTheDocument();
    expect(screen.getByText('12:00 – 12:30')).toBeInTheDocument();
    expect(screen.getByText('Acme BV')).toBeInTheDocument();
    expect(screen.getByText('Front of house')).toBeInTheDocument();
    expect(screen.getByText('2 left')).toBeInTheDocument();
    expect(screen.getByText('Bring the keys')).toBeInTheDocument();
    expect(screen.queryByText(/Badge/)).not.toBeInTheDocument();
  });

  it('falls back to a generic title and dashes without work type, break and notes', () => {
    shifts = [
      makeShift({
        workType: null,
        breakStartsAt: null,
        breakEndsAt: null,
        notes: null,
        companyName: null,
        departmentName: null,
      }),
    ];
    renderPanel();
    expect(screen.getByText('Open shift')).toBeInTheDocument();
    expect(screen.queryByText('12:00 – 12:30')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('shows my sign-up and the reviewer note', () => {
    shifts = [
      makeShift({
        myRequest: {
          id: 'request_1',
          status: 'rejected',
          reviewNote: 'Already covered',
        },
      }),
    ];
    renderPanel();
    expect(screen.getByText('Badge rejected')).toBeInTheDocument();
    expect(screen.getByText('Already covered')).toBeInTheDocument();
  });

  it('shows no review note for a sign-up without one', () => {
    shifts = [
      makeShift({
        myRequest: { id: 'request_1', status: 'pending', reviewNote: null },
      }),
    ];
    renderPanel();
    expect(screen.getByText('Badge pending')).toBeInTheDocument();
    expect(screen.queryByText('Already covered')).not.toBeInTheDocument();
  });

  it('opens the sign-up dialog from the menu and closes it again', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign up here' }));
    await user.click(await screen.findByRole('button', { name: 'Dialog for open_1' }));
    expect(screen.queryByRole('button', { name: /Dialog for/ })).not.toBeInTheDocument();
  });

  it('withdraws the sign-up from the menu', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Withdraw here' }));
    expect(mocks.withdraw).toHaveBeenCalledWith('request_1');
  });

  it('says so when the shift is no longer open', () => {
    shifts = [];
    renderPanel();
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

  it('shows nothing of the shift while loading', () => {
    queryState = 'loading';
    renderPanel();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme BV')).not.toBeInTheDocument();
  });
});
