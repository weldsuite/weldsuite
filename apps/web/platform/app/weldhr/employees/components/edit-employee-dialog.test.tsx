import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  update: vi.fn(),
  isPending: false,
  departments: [] as unknown[],
  locationOptions: [] as Array<{ value: string; label: string }>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./employer-field', () => ({ EmployerField: () => <div data-testid="employer-field" /> }));
vi.mock('./work-locations-field', () => ({
  useWorkLocationOptions: () => state.locationOptions,
  WorkLocationsField: () => <div data-testid="locations-field" />,
}));
vi.mock('../../components/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/shared')>()),
  EmployeePicker: ({ valueLabel }: { valueLabel: string | null }) => <div data-testid="manager">{valueLabel}</div>,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrDepartments: () => ({ data: state.departments }),
  useUpdateHrEmployee: () => ({ mutateAsync: state.update, isPending: state.isPending }),
}));

import { EditEmployeeDialog } from './edit-employee-dialog';

const t = en.weldhr.employees.create;
const overview = en.weldhr.employees.detail.overview;
const edit = en.weldhr.employees.detail.edit;

function employee(over: Partial<HrEmployeeDetail> = {}): HrEmployeeDetail {
  return {
    id: 'hremp_ann',
    employeeNumber: 'E-100',
    firstName: 'Ann',
    lastName: 'Archer',
    preferredName: null,
    pronouns: null,
    email: 'ann@example.com',
    phone: null,
    jobTitle: 'Cashier',
    employmentType: 'full_time',
    status: 'active',
    startDate: '2026-03-02',
    endDate: null,
    probationEndDate: '2026-06-02',
    location: null,
    timezone: null,
    weeklyHours: 38,
    departmentId: null,
    managerId: 'emp_boss',
    managerName: 'Bea Boss',
    legalEntityId: null,
    workLocationIds: ['loc_1', 'loc_gone'],
    ...over,
  } as HrEmployeeDetail;
}

function renderDialog(emp = employee()) {
  const onClose = vi.fn();
  renderWithProviders(<EditEmployeeDialog employee={emp} onClose={onClose} />);
  return { onClose };
}

beforeEach(() => {
  polyfillRadixSelect();
  state.isPending = false;
  state.departments = [];
  state.locationOptions = [];
  state.update.mockReset().mockResolvedValue({});
  vi.mocked(toast.success).mockReset();
});

describe('EditEmployeeDialog', () => {
  it('starts from the employee, with the dates in the list format', async () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: edit.title })).toBeInTheDocument();
    expect(screen.getByLabelText(t.firstName)).toHaveValue('Ann');
    expect(screen.getByLabelText(t.email)).toHaveValue('ann@example.com');
    expect(screen.getByTestId('manager')).toHaveTextContent('Bea Boss');
    expect(screen.getByLabelText(t.startDate)).toHaveTextContent(/2\s?Mar\w*,?\s2026|Mar\w*\s2,?\s2026/);
    expect(screen.getByLabelText(overview.probationEndDate)).toHaveTextContent(/2026/);
    // Valid from the start, so Save is enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeEnabled());
  });

  it('shows the placeholder for a date the employee does not have', () => {
    renderDialog();
    expect(screen.getByLabelText(overview.endDate)).toHaveTextContent(en.weldhr.common.pickDate);
  });

  it('disables Save while the form is invalid, and shows the error as you type', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeEnabled());
    await user.clear(screen.getByLabelText(t.firstName));
    expect(await screen.findByText(en.weldhr.employees.validation.firstNameRequired)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeDisabled();
  });

  it('keeps Save disabled when the end date is before the start date', async () => {
    renderDialog(employee({ endDate: '2026-01-01' }));
    await waitFor(() => expect(screen.getByLabelText(overview.endDate)).toHaveTextContent(/2026/));
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeDisabled());
  });

  it('keeps Save disabled when the probation ends before the start date', async () => {
    renderDialog(employee({ probationEndDate: '2026-01-01' }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeDisabled());
  });

  it('lets the end and probation dates be picked freely without a start date', async () => {
    const user = userEvent.setup();
    renderDialog(employee({ startDate: null, endDate: null, probationEndDate: null }));
    await user.click(screen.getByLabelText(overview.endDate));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    const days = screen.getAllByRole('gridcell').map((cell) => cell.querySelector('button')!);
    expect(days.every((day) => !day.disabled)).toBe(true);
  });

  it('disables the days before the start date on the end date', async () => {
    const user = userEvent.setup();
    renderDialog(employee({ startDate: '2026-03-10', endDate: '2026-03-20', probationEndDate: null }));
    await user.click(screen.getByLabelText(overview.endDate));
    expect(await screen.findByRole('button', { name: /March 9th, 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /March 11th, 2026/ })).toBeEnabled();
  });

  it('saves the changes and closes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeEnabled());
    await user.clear(screen.getByLabelText(t.jobTitle));
    await user.type(screen.getByLabelText(t.jobTitle), 'Manager');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]![0]).toMatchObject({
      id: 'hremp_ann',
      firstName: 'Ann',
      jobTitle: 'Manager',
      startDate: '2026-03-02',
      endDate: null,
      probationEndDate: '2026-06-02',
      weeklyHours: 38,
      managerId: 'emp_boss',
      departmentId: null,
      phone: null,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(edit.savedToast);
  });

  it('drops work locations that no longer exist', async () => {
    state.locationOptions = [{ value: 'loc_1', label: 'HQ' }];
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
    await waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update.mock.calls[0]![0].workLocationIds).toEqual(['loc_1']);
  });

  it('shows why saving failed and stays open', async () => {
    state.update.mockRejectedValue(new Error('Email already used'));
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
    expect(await screen.findByText('Email already used')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows Saving and cannot be cancelled while saving', () => {
    state.isPending = true;
    renderDialog();
    expect(screen.getByRole('button', { name: en.weldhr.common.saving })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.weldhr.common.cancel })).toBeDisabled();
  });

  it('closes with Cancel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    expect(onClose).toHaveBeenCalled();
  });
});
