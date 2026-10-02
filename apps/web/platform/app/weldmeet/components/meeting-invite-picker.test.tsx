import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mutateAsync = vi.fn();
let members: Array<{ userId: string; name: string; email: string }> = [];
let people: Array<{ id: string; displayName: string; email: string }> = [];

vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useMeeting: () => ({ data: { attendees: [{ email: 'already@acme.com' }] } }),
  useInviteToMeeting: () => ({ mutateAsync }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: members } }),
  useWorkspaceMemberSearch: () => ({ data: { data: members }, isFetching: false }),
}));
vi.mock('@/hooks/queries/use-people-queries', () => ({
  usePersonSearch: () => ({ data: { data: people }, isFetching: false }),
}));
// No debounce delay in tests.
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { MeetingInvitePicker } from './meeting-invite-picker';

const PLACEHOLDER = 'Search people or type an email...';

beforeEach(() => {
  mutateAsync.mockReset();
  members = [];
  people = [];
});

describe('MeetingInvitePicker', () => {
  it('offers "Invite <email>" for an address that is not a member and invites it', async () => {
    mutateAsync.mockResolvedValue({
      attendees: [],
      invited: [{ email: 'weldhost@gmail.com', name: 'weldhost@gmail.com', emailSent: true }],
      alreadyInvited: [],
    });
    render(<MeetingInvitePicker meetingId="mtg_1" />);

    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
      target: { value: 'WeldHost@gmail.com' },
    });

    expect(screen.getByText('Invite weldhost@gmail.com')).toBeInTheDocument();
    expect(screen.queryByText(/No people found/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        meetingId: 'mtg_1',
        invitees: [{ email: 'weldhost@gmail.com' }],
      }),
    );
  });

  it('lists CRM people next to members and marks existing attendees as invited', () => {
    members = [{ userId: 'user_1', name: 'Already There', email: 'already@acme.com' }];
    people = [{ id: 'per_1', displayName: 'Crm Person', email: 'crm@client.com' }];
    render(<MeetingInvitePicker meetingId="mtg_1" />);

    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'a' } });

    expect(screen.getByText('CRM people')).toBeInTheDocument();
    expect(screen.getByText('Crm Person')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invited/ })).toBeDisabled();
  });

  it('explains how to invite outsiders when nothing matches', () => {
    render(<MeetingInvitePicker meetingId="mtg_1" />);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'nobody' } });
    expect(screen.getByText(/Type a full email address/)).toBeInTheDocument();
  });
});
