import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Opening a workspace invite while already signed in to another workspace
// (e.g. from WeldMail) must accept it and switch to that workspace (TASK-1074).

interface FakeInvitation {
  publicOrganizationData: { id: string; name: string };
  accept: ReturnType<typeof vi.fn>;
}

const clerk = vi.hoisted(() => ({
  isSignedIn: true as boolean,
  invitations: [] as FakeInvitation[],
  setOrgActive: vi.fn(),
  signInCreate: vi.fn(),
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isSignedIn: clerk.isSignedIn }),
  useSignIn: () => ({ isLoaded: true, signIn: { create: clerk.signInCreate }, setActive: vi.fn() }),
  useSignUp: () => ({ isLoaded: true, signUp: { create: vi.fn() }, setActive: vi.fn() }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: clerk.setOrgActive,
    userInvitations: { data: clerk.invitations, isLoading: false },
  }),
  useClerk: () => ({
    signOut: vi.fn(),
    user: { primaryEmailAddress: { emailAddress: 'member@example.com' } },
  }),
}));

vi.mock('@clerk/clerk-react/errors', () => ({ isClerkAPIResponseError: () => false }));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { InviteClient } from './invite-client';

const PENDING_ORG_KEY = 'weldsuite:pending-org';

function invitationInto(orgId: string): FakeInvitation {
  return {
    publicOrganizationData: { id: orgId, name: `Workspace ${orgId}` },
    accept: vi.fn().mockResolvedValue({}),
  };
}

async function renderInvite(props: { orgId?: string; clerkTicket?: string } = {}) {
  render(
    <InviteClient
      orgId={props.orgId}
      isAuthenticated={clerk.isSignedIn}
      clerkTicket={props.clerkTicket}
      clerkStatus="sign_in"
    />,
  );
  // Let the join effect and its awaited Clerk calls settle.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  // Fake only setTimeout so the delayed reload to '/' never runs in jsdom.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  sessionStorage.clear();
  clerk.isSignedIn = true;
  clerk.invitations = [];
  clerk.setOrgActive = vi.fn().mockResolvedValue(undefined);
  clerk.signInCreate = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InviteClient, signed in to another workspace', () => {
  it('accepts the invitation from the link and switches to its workspace', async () => {
    const other = invitationInto('org_other');
    const target = invitationInto('org_new');
    clerk.invitations = [other, target];

    await renderInvite({ orgId: 'org_new', clerkTicket: 'ticket_123' });

    expect(target.accept).toHaveBeenCalledTimes(1);
    expect(other.accept).not.toHaveBeenCalled();
    expect(clerk.setOrgActive).toHaveBeenCalledWith({ organization: 'org_new' });
    expect(sessionStorage.getItem(PENDING_ORG_KEY)).toBe('org_new');
    expect(clerk.signInCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Welcome!')).toBeTruthy();
  });

  it('switches to the workspace when the invitation was already accepted', async () => {
    await renderInvite({ orgId: 'org_new', clerkTicket: 'ticket_123' });

    expect(clerk.setOrgActive).toHaveBeenCalledWith({ organization: 'org_new' });
    expect(sessionStorage.getItem(PENDING_ORG_KEY)).toBe('org_new');
  });

  it('accepts the first pending invitation for links without a workspace id', async () => {
    const first = invitationInto('org_first');
    clerk.invitations = [first, invitationInto('org_second')];

    await renderInvite({ clerkTicket: 'ticket_123' });

    expect(first.accept).toHaveBeenCalledTimes(1);
    expect(clerk.setOrgActive).toHaveBeenCalledWith({ organization: 'org_first' });
  });

  it('offers to sign out when the invitation is for another account', async () => {
    clerk.setOrgActive = vi.fn().mockRejectedValue(new Error('not a member'));

    await renderInvite({ orgId: 'org_new', clerkTicket: 'ticket_123' });

    expect(screen.getByText('Wrong Account')).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_ORG_KEY)).toBeNull();
  });

  it('still opens the joined workspace when activating it fails after accepting', async () => {
    const target = invitationInto('org_new');
    clerk.invitations = [target];
    clerk.setOrgActive = vi.fn().mockRejectedValue(new Error('membership not cached yet'));

    await renderInvite({ orgId: 'org_new', clerkTicket: 'ticket_123' });

    expect(target.accept).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PENDING_ORG_KEY)).toBe('org_new');
    expect(screen.getByText('Welcome!')).toBeTruthy();
  });
});

describe('InviteClient, signed out', () => {
  it('signs in with the ticket instead of joining as a signed-in user', async () => {
    clerk.isSignedIn = false;
    clerk.signInCreate = vi.fn().mockResolvedValue({ status: 'complete', createdSessionId: 'sess_1' });

    await renderInvite({ orgId: 'org_new', clerkTicket: 'ticket_123' });

    expect(clerk.signInCreate).toHaveBeenCalledWith({ strategy: 'ticket', ticket: 'ticket_123' });
    expect(clerk.setOrgActive).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_ORG_KEY)).toBe('org_new');
  });
});
