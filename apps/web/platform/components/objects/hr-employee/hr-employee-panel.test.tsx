import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';

const updateAsync = vi.fn();
const deleteAsync = vi.fn();
const refetch = vi.fn();
const toastError = vi.fn();
const permissions = new Set<string>();
let employee: HrEmployeeDetail;
/** How the employee query answers: loaded, still loading, or failed. */
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';

vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  useObjectPanelNavigationReporter: () => () => {},
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (message: string) => toastError(message) } }));
vi.mock('@/contexts/compose-context', () => ({ useComposeSafe: () => null }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrEmployee: () => ({
    data: queryState === 'loaded' ? employee : undefined,
    isLoading: queryState === 'loading',
    isError: queryState === 'failed',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch,
  }),
  useUpdateHrEmployee: () => ({ mutateAsync: updateAsync, isPending: false }),
  useDeleteHrEmployee: () => ({ mutateAsync: deleteAsync, isPending: false }),
  useHrDepartments: () => ({ data: [] }),
  useHrEmployees: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({ useHrPayrollFlag: () => ({ enabled: false }) }));
// The tab bodies and dialogs that come from WeldHR have tests of their own.
vi.mock('@/app/weldhr/components/employee-tabs/attendance-tab', () => ({ EmployeeAttendanceTab: () => null }));
vi.mock('@/app/weldhr/components/employee-tabs/leave-tab', () => ({ EmployeeLeaveTab: () => null }));
vi.mock('@/app/weldhr/components/employee-tabs/payroll-tab', () => ({ EmployeePayrollTab: () => null }));
vi.mock('@/app/weldhr/employees/components/sensitive-panel', () => ({ SensitivePanel: () => null }));
vi.mock('@/app/weldhr/employees/components/edit-employee-dialog', () => ({ EditEmployeeDialog: () => null }));
vi.mock('@/app/weldhr/employees/components/workspace-account-row', () => ({ EmployeeWorkspaceAccountRow: () => null }));
vi.mock('@/components/custom-fields/custom-fields-sidebar-section', () => ({ CustomFieldsSidebarSection: () => null }));

import { HrEmployeePanel } from './hr-employee-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeEmployee(extra: Partial<HrEmployeeDetail> = {}): HrEmployeeDetail {
  return {
    id: 'hremp_ann',
    employeeNumber: null,
    firstName: 'Ann',
    lastName: 'Archer',
    preferredName: null,
    displayName: 'Ann Archer',
    email: 'ann@example.com',
    phone: null,
    avatarUrl: null,
    pronouns: null,
    jobTitle: null,
    departmentId: null,
    managerId: null,
    userId: 'user_ann',
    employmentType: 'full_time',
    status: 'active',
    startDate: '2026-01-05',
    endDate: null,
    probationEndDate: null,
    location: null,
    timezone: null,
    weeklyHours: 40,
    workLocationIds: null,
    customFields: null,
    hasSensitive: false,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    departmentName: null,
    managerName: null,
    clients: [],
    directReports: [],
    ...extra,
  } as HrEmployeeDetail;
}

function renderPanel(onClose = vi.fn()) {
  return renderWithProviders(
    <HrEmployeePanel id="hremp_ann" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

describe('HrEmployeePanel', () => {
  beforeEach(() => {
    updateAsync.mockReset().mockResolvedValue({});
    deleteAsync.mockReset().mockResolvedValue({});
    refetch.mockReset();
    toastError.mockReset();
    queryState = 'loaded';
    panelOpen.mockReset();
    permissions.clear();
    employee = makeEmployee();
  });

  it('shows the employee as editable property rows, with only the tabs the member may open', () => {
    permissions.add('employees:update');
    permissions.add('attendance:read');
    renderPanel();

    expect(screen.getAllByText('Ann Archer').length).toBeGreaterThanOrEqual(1);
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Details', 'Direct reports', 'Attendance']);
    // Inline editors on the rows, as on a company.
    expect(screen.getByRole('button', { name: 'First name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job title' })).toBeInTheDocument();
    expect(screen.getByText('Set Job title…')).toBeInTheDocument();
  });

  it('is read-only for a member who may not update employees', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: 'First name' })).not.toBeInTheDocument();
    expect(screen.queryByText('Set Job title…')).not.toBeInTheDocument();
    expect(screen.getByText('Ann')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('refuses to clear a name instead of saving it', async () => {
    permissions.add('employees:update');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'First name' }));
    await user.clear(screen.getByDisplayValue('Ann'));
    await user.keyboard('{Enter}');

    expect(toastError).toHaveBeenCalledWith('First name is required');
    expect(updateAsync).not.toHaveBeenCalled();
  });

  it('saves weekly hours as a number and refuses hours a week does not have', async () => {
    permissions.add('employees:update');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Weekly hours' }));
    await user.clear(screen.getByDisplayValue('40'));
    await user.type(screen.getByRole('textbox'), '200{Enter}');
    expect(toastError).toHaveBeenCalledWith('Enter a number of hours between 0 and 168');
    expect(updateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Weekly hours' }));
    await user.clear(screen.getByDisplayValue('40'));
    await user.type(screen.getByRole('textbox'), '32,5{Enter}');
    expect(updateAsync).toHaveBeenCalledWith({ id: 'hremp_ann', weeklyHours: 32.5 });
  });

  it('lists direct reports and opens one in place of this employee', async () => {
    employee = makeEmployee({
      directReports: [
        {
          id: 'hremp_bob',
          displayName: 'Bob Baker',
          jobTitle: 'Engineer',
          avatarUrl: null,
          status: 'onboarding',
        },
      ],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Direct reports' }));
    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bob Baker' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'hr_employee', id: 'hremp_bob', stack: true });
  });

  it('shows placeholders while the employee loads, and a retry when it fails', async () => {
    queryState = 'loading';
    const { unmount } = renderPanel();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    unmount();

    queryState = 'failed';
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('checks an email address and a phone number before saving them', async () => {
    permissions.add('employees:update');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.clear(screen.getByDisplayValue('ann@example.com'));
    await user.type(screen.getByRole('textbox'), 'not-an-email{Enter}');
    expect(toastError).toHaveBeenCalledWith('Enter a valid email address');

    await user.click(screen.getByRole('button', { name: 'Phone' }));
    await user.type(screen.getByRole('textbox'), 'call me{Enter}');
    expect(toastError).toHaveBeenCalledWith('Enter a phone number with digits only, such as +31 20 123 4567');
    expect(updateAsync).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Goes by' }));
    await user.type(screen.getByRole('textbox'), 'Annie{Enter}');
    expect(updateAsync).toHaveBeenCalledWith({ id: 'hremp_ann', preferredName: 'Annie' });
  });

  it('says so when a change could not be saved', async () => {
    permissions.add('employees:update');
    updateAsync.mockRejectedValue(new Error('Conflict'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Location' }));
    await user.type(screen.getByRole('textbox'), 'Amsterdam{Enter}');
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('deletes the employee after asking, and closes the panel', async () => {
    permissions.add('employees:delete');
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel(onClose);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByText('Delete employee')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteAsync).toHaveBeenCalledWith('hremp_ann');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('writes an email and calls from the header', async () => {
    employee = makeEmployee({ phone: '+31201234567' });
    const user = userEvent.setup();
    const hrefs: string[] = [];
    const location = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(value: string) { hrefs.push(value); } } });
    try {
      renderPanel();
      await user.click(screen.getByRole('button', { name: 'Compose email' }));
      await user.click(screen.getByRole('button', { name: 'Call' }));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: location });
    }
    expect(hrefs).toEqual(['mailto:ann@example.com', 'tel:+31201234567']);
  });

  it('keeps the current manager pickable when the candidate list does not hold them', async () => {
    permissions.add('employees:update');
    employee = makeEmployee({ managerId: 'hremp_boss', managerName: 'Bea Boss' });
    renderPanel();

    expect(screen.getByText('Bea Boss')).toBeInTheDocument();
  });
});
