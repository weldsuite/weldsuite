import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Navigate } from '@tanstack/react-router';
import { InviteClient } from './invite-client';

export default function InvitePage() {
  const { isSignedIn, orgId } = useAuth();

  // Read search params directly from the URL to ensure Clerk's redirect
  // params (__clerk_ticket, __clerk_status) are always captured, regardless
  // of TanStack Router's search-param validation.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  // Extract Clerk's native invitation parameters
  const clerkTicket = params.get('__clerk_ticket') || undefined;
  const clerkStatus = (params.get('__clerk_status') || undefined) as 'sign_in' | 'sign_up' | undefined;

  // Extract invitation parameters from URL
  const orgIdParam = params.get('org_id') || params.get('orgId') || undefined;
  const invitationId = params.get('invitation_id') || params.get('invitationId') || params.get('id') || undefined;
  const email = params.get('email') || undefined;
  const orgName = params.get('org_name') || params.get('orgName') || params.get('organization') || undefined;

  // If user is already authenticated with an organization, go to dashboard
  if (isSignedIn && orgId) {
    return <Navigate to="/" />;
  }

  return (
    <InviteClient
      orgId={orgIdParam}
      orgName={orgName}
      invitationId={invitationId}
      email={email}
      isAuthenticated={!!isSignedIn}
      clerkTicket={clerkTicket}
      clerkStatus={clerkStatus}
    />
  );
}
