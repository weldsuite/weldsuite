import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link2 } from 'lucide-react';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';

const permissions = new Set<string>();
const updateAsync = vi.fn();
const inviteMember = vi.fn();
const refetchPending = vi.fn();
const toastSuccess = vi.fn();
let pendingMembers: Array<{ email: string }> = [];
let available: Array<{ userId: string; name: string; email: string }> = [];

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: (message: string) => toastSuccess(message), error: vi.fn() } }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ teamMembers: { inviteMember } }) }));
vi.mock('@/hooks/queries/use-team-queries', () => ({
  useMemberProfile: () => ({ data: { name: 'Ann Archer', email: 'ann@example.com', picture: null } }),
  useTeamMembers: () => ({ data: { data: pendingMembers }, refetch: refetchPending }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceRoles: () => ({ data: { data: [{ id: 'role_admin', name: 'Admin' }, { id: 'role_member', name: 'Member' }] } }),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrAvailableMembers: () => ({ data: available }),
  useUpdateHrEmployee: () => ({ mutateAsync: updateAsync }),
}));

import { EmployeeWorkspaceAccountRow } from './workspace-account-row';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeEmployee(extra: Partial<HrEmployeeDetail> = {}): HrEmployeeDetail {
  return { id: 'hremp_ann', displayName: 'Ann Archer', email: 'ann@example.com', userId: null, ...extra } as HrEmployeeDetail;
}

const renderRow = (employee = makeEmployee()) => renderWithProviders(<EmployeeWorkspaceAccountRow employee={employee} icon={Link2} />);

describe('EmployeeWorkspaceAccountRow', () => {
  beforeEach(() => {
    polyfillRadixSelect();
    permissions.clear();
    updateAsync.mockReset().mockResolvedValue({});
    inviteMember.mockReset().mockResolvedValue({});
    refetchPending.mockReset();
    toastSuccess.mockReset();
    panelOpen.mockReset();
    pendingMembers = [];
    available = [];
  });

  it('shows the linked member, who opens in their own panel', async () => {
    const user = userEvent.setup();
    renderRow(makeEmployee({ userId: 'user_ann' }));

    expect(screen.getByText('Account')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ann Archer/ }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'team-member', id: 'user_ann', stack: true });
  });

  it('says an invitation is on its way while one waits for this email', () => {
    permissions.add('team:read');
    pendingMembers = [{ email: 'ANN@example.com' }];
    renderRow();

    expect(screen.getByText('Invitation sent')).toBeInTheDocument();
  });

  it('only says "Not linked" to someone who may neither link nor invite', () => {
    renderRow();

    expect(screen.getByText('Not linked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not linked' })).not.toBeInTheDocument();
  });

  it('links the member with the same email, picked for you', async () => {
    permissions.add('employees:update');
    available = [{ userId: 'user_ann', name: 'Ann A.', email: 'ann@example.com' }];
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Not linked' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Link matching member' }));
    expect(screen.getByText('A team member with the same email was found: Ann A..')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Link member' }));

    expect(updateAsync).toHaveBeenCalledWith({ id: 'hremp_ann', userId: 'user_ann' });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Employee linked to the workspace member.'));
  });

  it('invites them as an Employee member, without a role', async () => {
    permissions.add('team:create');
    permissions.add('team:read');
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Not linked' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Invite to workspace' }));
    expect(screen.getByRole('heading', { name: 'Invite as workspace member' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send invitation/ }));

    expect(inviteMember).toHaveBeenCalledWith({ email: 'ann@example.com', name: 'Ann Archer', roleId: null, memberType: 'EMPLOYEE' });
    await waitFor(() => expect(refetchPending).toHaveBeenCalled());
  });

  it('keeps the dialog open with the reason when the invitation fails', async () => {
    permissions.add('team:create');
    inviteMember.mockRejectedValue(new Error('Seat limit reached'));
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: 'Not linked' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Invite to workspace' }));
    await user.click(screen.getByRole('button', { name: /Send invitation/ }));

    expect(await screen.findByText(/Seat limit reached|Could not invite/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invite as workspace member' })).toBeInTheDocument();
  });
});
