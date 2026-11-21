import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import WeldHrSettingsPage from './page';

let tab: string | undefined;
let canManage = true;
let canPayroll = false;
let payrollEnabled = false;
const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({ tab }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({
    can: (permission: string) =>
      (canManage && permission === 'employees:manage') || (canPayroll && permission === 'payroll:manage'),
  }),
}));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollFlag: () => ({ enabled: payrollEnabled, isLoading: false }),
}));

vi.mock('./pay-schedules-tab', () => ({
  PaySchedulesTab: () => <div>pay schedules panel</div>,
}));

vi.mock('@/app/weldhr/settings/components/departments-tab', () => ({
  DepartmentsTab: () => <div>departments panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/leave-types-tab', () => ({
  LeaveTypesTab: () => <div>leave types panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/work-locations-tab', () => ({
  WorkLocationsTab: () => <div>work locations panel</div>,
}));
vi.mock('@/app/weldhr/settings/components/self-service-tab', () => ({
  SelfServiceTab: () => <div>self-service panel</div>,
}));

describe('WeldHR settings page', () => {
  beforeEach(() => {
    tab = undefined;
    canManage = true;
    canPayroll = false;
    payrollEnabled = false;
    navigate.mockClear();
  });

  it('shows the settings title and the departments tab by default', () => {
    render(<WeldHrSettingsPage />);

    expect(screen.getByRole('heading', { name: en.settings.weldhr.title })).toBeTruthy();
    expect(screen.getByText(en.settings.weldhr.description)).toBeTruthy();
    expect(screen.getByText('departments panel')).toBeTruthy();
    expect(screen.queryByText('leave types panel')).toBeNull();
  });

  it('opens the tab from the query string', () => {
    tab = 'leave-types';
    render(<WeldHrSettingsPage />);

    expect(screen.getByText('leave types panel')).toBeTruthy();
    expect(screen.queryByText('departments panel')).toBeNull();
  });

  it('opens the My HR self-service switches', () => {
    tab = 'self-service';
    render(<WeldHrSettingsPage />);

    expect(screen.getByText('self-service panel')).toBeTruthy();
    expect(screen.getByRole('tab', { name: en.weldhr.settings.tabs.selfService })).toBeTruthy();
  });

  it('opens the work locations tab from the query string', () => {
    tab = 'work-locations';
    render(<WeldHrSettingsPage />);

    expect(screen.getByText('work locations panel')).toBeTruthy();
    expect(screen.queryByText('departments panel')).toBeNull();
  });

  it('writes the selected tab into the settings URL', () => {
    render(<WeldHrSettingsPage />);

    fireEvent.click(screen.getByRole('tab', { name: en.weldhr.settings.tabs.leaveTypes }));

    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/apps/weldhr',
      search: { tab: 'leave-types' },
    });
  });

  it('adds the pay schedules with the payroll flag and payroll:manage', () => {
    canPayroll = true;
    payrollEnabled = true;
    tab = 'pay-schedules';
    render(<WeldHrSettingsPage />);

    expect(screen.getByRole('tab', { name: en.weldhr.settings.tabs.paySchedules })).toBeTruthy();
    expect(screen.getByText('pay schedules panel')).toBeTruthy();
  });

  it('leaves the pay schedules out while the payroll flag is off', () => {
    canPayroll = true;
    tab = 'pay-schedules';
    render(<WeldHrSettingsPage />);

    expect(screen.queryByRole('tab', { name: en.weldhr.settings.tabs.paySchedules })).toBeNull();
    expect(screen.getByText('departments panel')).toBeTruthy();
  });

  it('shows only the pay schedules to a payroll manager without employees:manage', () => {
    canManage = false;
    canPayroll = true;
    payrollEnabled = true;
    render(<WeldHrSettingsPage />);

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByText('pay schedules panel')).toBeTruthy();
  });

  it('hides the editors without employees:manage', () => {
    canManage = false;
    render(<WeldHrSettingsPage />);

    expect(screen.getByText(en.weldhr.common.noPermission)).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
