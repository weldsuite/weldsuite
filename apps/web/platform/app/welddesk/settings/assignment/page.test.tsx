import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { DeskAssignmentSettings } from '@/hooks/queries/use-desk-queries';
import DeskAssignmentSettingsPage from './page';

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let settings: DeskAssignmentSettings;

vi.mock('@/hooks/queries/use-desk-queries', () => ({
  useDeskAssignment: () => ({ data: settings, isLoading: false }),
  useUpdateDeskAssignment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetDeskAway: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/use-desk-workspace-members', () => ({
  useDeskWorkspaceMembers: () => ({
    data: [
      { id: 'user_ann', userId: 'user_ann', name: 'Ann', email: 'ann@acme.test', picture: null, role: 'ADMIN', status: 'ACTIVE' },
      { id: 'user_bob', userId: 'user_bob', name: 'Bob', email: 'bob@acme.test', picture: null, role: 'MEMBER', status: 'ACTIVE' },
    ],
    isLoading: false,
  }),
}));

const base = (): DeskAssignmentSettings => ({
  mode: 'round_robin',
  memberIds: ['user_ann'],
  awayMemberIds: [],
  maxOpenPerMember: null,
  me: { inRotation: true, away: false },
});

const memberBoxes = () => screen.getAllByTestId('desk-assignment-member');

describe('DeskAssignmentSettingsPage', () => {
  beforeEach(() => {
    settings = base();
  });

  it('keeps unsaved roster edits when the away switch updates the settings', () => {
    const { rerender } = render(<DeskAssignmentSettingsPage />);
    expect(memberBoxes()[1]).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(memberBoxes()[1]); // add Bob, not saved yet
    expect(memberBoxes()[1]).toHaveAttribute('data-state', 'checked');

    // The admin flips their own availability: the query gets a new object.
    settings = { ...base(), awayMemberIds: ['user_ann'], me: { inRotation: true, away: true } };
    act(() => rerender(<DeskAssignmentSettingsPage />));

    expect(memberBoxes()[1]).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('desk-assignment-save')).not.toBeDisabled();
  });

  it('takes changes from the server while the form has no unsaved edits', () => {
    const { rerender } = render(<DeskAssignmentSettingsPage />);
    settings = { ...base(), memberIds: ['user_ann', 'user_bob'] };
    act(() => rerender(<DeskAssignmentSettingsPage />));
    expect(memberBoxes()[1]).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('desk-assignment-save')).toBeDisabled();
  });
});
