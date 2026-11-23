import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAvailableMember } from '@weldsuite/app-api-client/domains/weldhr';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  members: [] as unknown[],
  membersLoading: false,
  departments: [] as unknown[],
  entityId: null as string | null,
  create: vi.fn(),
  isPending: false,
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/hooks/use-current-legal-entity', () => ({ useCurrentLegalEntity: () => ({ entityId: state.entityId }) }));
vi.mock('./employer-field', () => ({ EmployerField: () => <div data-testid="employer-field" /> }));
vi.mock('./work-locations-field', () => ({
  useWorkLocationOptions: () => [],
  WorkLocationsField: ({ onChange }: { onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['loc_1'])}>
      pick location
    </button>
  ),
}));
vi.mock('../../components/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/shared')>()),
  EmployeePicker: ({ onChange }: { onChange: (id: string | null, label: string | null) => void }) => (
    <button type="button" onClick={() => onChange('emp_boss', 'Bea Boss')}>
      pick manager
    </button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useCreateHrEmployeeFromMember: () => ({ mutateAsync: state.create, isPending: state.isPending }),
  useHrAvailableMembers: () => ({ data: state.members, isLoading: state.membersLoading }),
  useHrDepartments: () => ({ data: state.departments }),
}));

import { CreateEmployeeDialog } from './create-employee-dialog';

const t = en.weldhr.employees.create;

function member(over: Partial<HrAvailableMember> & { userId: string }): HrAvailableMember {
  return { name: 'Ann Archer', email: 'ann@example.com', phone: '+31 6 12345678', title: 'Cashier', memberType: 'INTERNAL', ...over } as HrAvailableMember;
}

function renderDialog(props: Partial<Parameters<typeof CreateEmployeeDialog>[0]> = {}) {
  const onClose = vi.fn();
  renderWithProviders(<CreateEmployeeDialog onClose={onClose} {...props} />);
  return { onClose };
}

const memberSelect = () => screen.getAllByRole('combobox')[0]!;

async function pickMember(user: ReturnType<typeof userEvent.setup>, label: RegExp | string) {
  await user.click(memberSelect());
  await user.click(await screen.findByRole('option', { name: label }));
}

beforeEach(() => {
  polyfillRadixSelect();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  state.membersLoading = false;
  state.entityId = null;
  state.isPending = false;
  state.departments = [{ id: 'dep_1', name: 'Sales' }];
  state.members = [member({ userId: 'user_ann' }), member({ userId: 'user_bob', name: 'Bob', email: null, phone: null, title: null, memberType: 'EMPLOYEE' })];
  state.create.mockReset().mockResolvedValue({ data: { id: 'hremp_new' } });
  state.navigate.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('CreateEmployeeDialog', () => {
  it('shows only the member picker until a member is chosen, with Create disabled', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: t.title })).toBeInTheDocument();
    expect(screen.queryByLabelText(t.firstName)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.submit })).toBeDisabled();
    expect(screen.queryByText(t.noMembersAvailable)).not.toBeInTheDocument();
  });

  it('tells the user to invite someone first when every member already has a record', () => {
    state.members = [];
    renderDialog();
    expect(screen.getByText(t.noMembersAvailable)).toBeInTheDocument();
    expect(memberSelect()).toBeDisabled();
  });

  it('does not claim there are no members while they load', () => {
    state.members = [];
    state.membersLoading = true;
    renderDialog();
    expect(screen.queryByText(t.noMembersAvailable)).not.toBeInTheDocument();
  });

  it('prefills the form from the chosen member and tags employee members', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderDialog();
    await user.click(memberSelect());
    expect(await screen.findByRole('option', { name: /Ann Archer · ann@example.com/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: new RegExp(`Bob.*${t.employeeMemberTag}`) })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Ann Archer/ }));

    expect(screen.getByLabelText(t.firstName)).toHaveValue('Ann');
    expect(screen.getByLabelText(t.lastName)).toHaveValue('Archer');
    expect(screen.getByLabelText(t.email)).toHaveValue('ann@example.com');
    expect(screen.getByLabelText(t.phone)).toHaveValue('+31 6 12345678');
    expect(screen.getByLabelText(t.jobTitle)).toHaveValue('Cashier');
    expect(screen.getByRole('button', { name: t.submit })).toBeEnabled();
  });

  it('uses a one-word name as both first and last name, and leaves missing details empty', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderDialog();
    await pickMember(user, /Bob/);
    expect(screen.getByLabelText(t.firstName)).toHaveValue('Bob');
    expect(screen.getByLabelText(t.lastName)).toHaveValue('Bob');
    expect(screen.getByLabelText(t.email)).toHaveValue('');
    expect(screen.getByLabelText(t.phone)).toHaveValue('');
  });

  it('labels a member without a name by their email, and without either by their user id', async () => {
    vi.useRealTimers();
    state.members = [member({ userId: 'user_mail', name: '', email: 'only@example.com' }), member({ userId: 'user_bare', name: '', email: null })];
    const user = userEvent.setup();
    renderDialog();
    await user.click(memberSelect());
    expect(await screen.findByRole('option', { name: 'only@example.com' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'user_bare' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'user_bare' }));
    // No name at all: both name fields stay empty.
    expect(screen.getByLabelText(t.firstName)).toHaveValue('');
  });

  it('can go back to no member, which hides the fields again', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.click(memberSelect());
    await user.click(await screen.findByRole('option', { name: t.memberPlaceholder }));
    expect(screen.queryByLabelText(t.firstName)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.submit })).toBeDisabled();
  });

  it('preselects the default member once the list has them', async () => {
    renderDialog({ defaultUserId: 'user_ann' });
    expect(await screen.findByLabelText(t.firstName)).toHaveValue('Ann');
  });

  it('shows today as the default start date in the list format', async () => {
    vi.useRealTimers();
    renderDialog({ defaultUserId: 'user_ann' });
    await screen.findByLabelText(t.firstName);
    const label = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    expect(screen.getByLabelText(t.startDate)).toHaveTextContent(label);
  });

  it('creates the employee from the member and opens their profile', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.click(screen.getByRole('button', { name: 'pick manager' }));
    await user.click(screen.getByRole('button', { name: 'pick location' }));
    await user.click(screen.getByRole('button', { name: t.submit }));

    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]![0]).toMatchObject({
      userId: 'user_ann',
      firstName: 'Ann',
      lastName: 'Archer',
      email: 'ann@example.com',
      employmentType: 'full_time',
      status: 'onboarding',
      managerId: 'emp_boss',
      workLocationIds: ['loc_1'],
      departmentId: null,
      preferredName: null,
    });
    expect(state.create.mock.calls[0]![0]).not.toHaveProperty('legalEntityId');
    expect(onClose).toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldhr/employees/$employeeId', params: { employeeId: 'hremp_new' } });
  });

  it('sends the current legal entity', async () => {
    vi.useRealTimers();
    state.entityId = 'ent_2';
    const user = userEvent.setup();
    renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.click(screen.getByRole('button', { name: t.submit }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0]![0]).toMatchObject({ legalEntityId: 'ent_2' });
  });

  it('hands the new employee to onCreated instead of navigating', async () => {
    vi.useRealTimers();
    const onCreated = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onCreated });
    await pickMember(user, /Ann Archer/);
    await user.click(screen.getByRole('button', { name: t.submit }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('hremp_new'));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('shows why creating failed and stays open', async () => {
    vi.useRealTimers();
    state.create.mockRejectedValue(new Error('Email already used'));
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.click(screen.getByRole('button', { name: t.submit }));
    expect(await screen.findByText('Email already used')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a general message when the failure has none', async () => {
    vi.useRealTimers();
    state.create.mockRejectedValue('x');
    const user = userEvent.setup();
    renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.click(screen.getByRole('button', { name: t.submit }));
    expect(await screen.findByText(t.failed)).toBeInTheDocument();
  });

  it('validates the form before creating', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderDialog();
    await pickMember(user, /Ann Archer/);
    await user.clear(screen.getByLabelText(t.firstName));
    await user.click(screen.getByRole('button', { name: t.submit }));
    expect(await screen.findByText(en.weldhr.employees.validation.firstNameRequired)).toBeInTheDocument();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('shows Saving while the employee is being created and cannot be cancelled', () => {
    state.isPending = true;
    renderDialog({ defaultUserId: 'user_ann' });
    expect(screen.getByRole('button', { name: en.weldhr.common.saving })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.weldhr.common.cancel })).toBeDisabled();
  });

  it('closes with Cancel', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    expect(onClose).toHaveBeenCalled();
  });

  it('lists the departments to choose from', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderDialog({ defaultUserId: 'user_ann' });
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: new RegExp(t.department) }));
    expect(await screen.findByRole('option', { name: 'Sales' })).toBeInTheDocument();
  });
});
