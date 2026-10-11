import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ isSignedIn: true, orgId: 'org_current' as string | null }));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => auth,
}));

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => <div>navigate:{to}</div>,
}));

vi.mock('./invite-client', () => ({
  InviteClient: ({ orgId, clerkTicket }: { orgId?: string; clerkTicket?: string }) => (
    <div>
      invite-client:{orgId ?? '-'}:{clerkTicket ?? '-'}
    </div>
  ),
}));

import InvitePage from './page';

function visit(search: string) {
  window.history.pushState({}, '', `/invite${search}`);
  render(<InvitePage />);
}

beforeEach(() => {
  auth.isSignedIn = true;
  auth.orgId = 'org_current';
});

describe('InvitePage', () => {
  // TASK-1074: a member signed in to another workspace was sent to '/' and
  // never joined the workspace the invite was for.
  it('keeps a signed-in member on the page when the link carries an invitation', () => {
    visit('?org_id=org_new&__clerk_ticket=ticket_123&__clerk_status=sign_in');
    expect(screen.getByText('invite-client:org_new:ticket_123')).toBeTruthy();
  });

  it('sends a signed-in member with nothing to accept to the dashboard', () => {
    visit('');
    expect(screen.getByText('navigate:/')).toBeTruthy();
  });

  it('shows the invitation to signed-out visitors', () => {
    auth.isSignedIn = false;
    auth.orgId = null;
    visit('?__clerk_ticket=ticket_123&__clerk_status=sign_up');
    expect(screen.getByText('invite-client:-:ticket_123')).toBeTruthy();
  });
});
