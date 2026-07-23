import { useMemo } from 'react';
import { Navigate } from '@tanstack/react-router';
import { AcceptInviteClient } from './accept-invite-client';

export default function AcceptInvitePage() {
  // Read search params directly from the URL to ensure they're always
  // captured, regardless of TanStack Router's search-param validation.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get('token');

  if (!token) {
    return <Navigate to="/" />;
  }

  return (
    <AcceptInviteClient
      token={token}
      initialInvitation={null}
      initialError={null}
    />
  );
}
