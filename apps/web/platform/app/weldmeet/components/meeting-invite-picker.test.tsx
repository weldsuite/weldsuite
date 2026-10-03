import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@weldsuite/ui/components/dialog';

const mutateAsync = vi.fn();
let members: Array<{ userId: string; name: string; email: string }> = [];
let people: Array<{ id: string; displayName: string; email: string }> = [];

vi.mock('@/hooks/queries/use-weldmeet-queries', () => ({
  useMeeting: () => ({
    data: {
      organizerId: 'user_host',
      attendees: [
        { email: 'host@acme.com', role: 'organizer', userId: 'user_host' },
        { email: 'already@acme.com', role: 'attendee' },
      ],
    },
  }),
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

  it('labels the organizer instead of offering or showing them as invited', () => {
    members = [
      { userId: 'user_host', name: 'Host Person', email: 'host@acme.com' },
      { userId: 'user_2', name: 'Colleague', email: 'colleague@acme.com' },
    ];
    render(<MeetingInvitePicker meetingId="mtg_1" />);

    expect(screen.getByText('Organizer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invited/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(1);
  });

  it('lets Escape close the surrounding dialog', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Add people</DialogTitle>
            <DialogDescription>Invite people</DialogDescription>
            <MeetingInvitePicker meetingId="mtg_1" />
          </DialogContent>
        </Dialog>
      );
    }
    render(<Harness />);
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'someone' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('explains how to invite outsiders when nothing matches', () => {
    render(<MeetingInvitePicker meetingId="mtg_1" />);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: 'nobody' } });
    expect(screen.getByText(/Type a full email address/)).toBeInTheDocument();
  });
});
