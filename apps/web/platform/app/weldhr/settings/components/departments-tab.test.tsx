import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrDepartment } from '@weldsuite/app-api-client/domains/weldhr';
import { DepartmentsTab } from './departments-tab';

const t = en.weldhr.settings.departments;

const state = vi.hoisted(() => ({
  canManage: true,
  departments: undefined as unknown,
  employees: undefined as unknown,
  employeeParams: [] as unknown[],
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => state.canManage }) }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('./color-field', () => ({ ColorField: () => <div data-testid="color-field" /> }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrDepartments: () => ({ data: state.departments, isLoading: state.isLoading, error: state.error }),
  useHrEmployees: (params: unknown) => {
    state.employeeParams.push(params);
    return { data: state.employees, isLoading: false };
  },
  useCreateHrDepartment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateHrDepartment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteHrDepartment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function department(over: Partial<HrDepartment> & { id: string }): HrDepartment {
  return {
    name: `Dept ${over.id}`,
    description: null,
    parentId: null,
    headEmployeeId: null,
    color: null,
    employeeCount: 0,
    ...over,
  } as HrDepartment;
}

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <DepartmentsTab />
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.canManage = true;
  state.isLoading = false;
  state.error = null;
  state.employeeParams = [];
  state.employees = { data: [{ id: 'emp_1', displayName: 'Anna de Vries' }] };
  state.departments = [
    department({ id: 'd_sales', name: 'Sales', headEmployeeId: 'emp_1', employeeCount: 4 }),
    department({ id: 'd_ops', name: 'Operations', headEmployeeId: 'emp_gone', parentId: 'd_sales', description: 'Keeps things running' }),
    department({ id: 'd_none', name: 'Support' }),
  ];
});

describe('DepartmentsTab', () => {
  it('loads the employees for the head names', () => {
    renderTab();
    expect(state.employeeParams).toContainEqual({ limit: 100 });
  });

  it('shows the head by name', () => {
    renderTab();
    expect(within(screen.getByTestId('row-d_sales')).getByText('Anna de Vries')).toBeInTheDocument();
  });

  it('says Assigned for a head the employee list does not hold, and a dash for no head', () => {
    renderTab();
    expect(within(screen.getByTestId('row-d_ops')).getByText(t.headAssigned)).toBeInTheDocument();
    expect(within(screen.getByTestId('row-d_none')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('says Assigned for every head while the employee list has not loaded', () => {
    state.employees = undefined;
    renderTab();
    expect(within(screen.getByTestId('row-d_sales')).getByText(t.headAssigned)).toBeInTheDocument();
  });

  it('shows the parent department and the description', () => {
    renderTab();
    const row = within(screen.getByTestId('row-d_ops'));
    expect(row.getByText('Keeps things running')).toBeInTheDocument();
    expect(row.getAllByText(/Sales/).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-d_sales')).getByText('4')).toBeInTheDocument();
  });

  it('searches by name and description', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText('search'), 'running');
    expect(screen.getByTestId('row-d_ops')).toBeInTheDocument();
    expect(screen.queryByTestId('row-d_sales')).not.toBeInTheDocument();
  });

  it('shows loading, error and the empty state with its add action', () => {
    state.isLoading = true;
    const first = renderTab();
    expect(screen.getByText('loading')).toBeInTheDocument();
    first.unmount();

    state.isLoading = false;
    state.error = new Error('Server down');
    const second = renderTab();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    second.unmount();

    state.error = null;
    state.departments = undefined;
    renderTab();
    expect(screen.getByText(t.emptyTitle)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: t.add })).toHaveLength(2);
  });

  it('opens the department dialog from Add', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getAllByRole('button', { name: t.add })[0]!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens the department dialog from Edit', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'edit d_sales' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('Sales')).toBeInTheDocument();
  });

  it('has no add, edit or delete without permission', () => {
    state.canManage = false;
    renderTab();
    expect(screen.queryByRole('button', { name: t.add })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edit d_sales' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'delete d_sales' })).not.toBeInTheDocument();
  });
});
