/**
 * `/invite` on an OIDC provider (the Kubernetes editions on Zitadel).
 *
 * Where WeldSuite shows its own sign-in screens (`auth.signIn: "platform"` in
 * `/config.json`, ADR SEC-016), the link in the invitation email opens here
 * instead of on the provider's page, with the account the provider made for
 * the invitee and the invite code (`?org_id=…&userId=…&code=…&email=…`):
 *
 * 1. The invitee chooses a password on Global's screen
 *    (`PasswordRequiredView`). `/api/sign-in/invitation/accept` checks the
 *    code with the provider, sets the password and opens a provider session.
 * 2. The page starts the platform's sign-in, which that session lets straight
 *    through, back to `/invite?org_id=…&joined=…`.
 * 3. Signed in, the invited member row is linked (`POST /api/invitations/accept`,
 *    which the identity sync would otherwise do within a minute) and the
 *    workspace opens.
 *
 * Without the platform's screens, or without a code in the link, the provider
 * manages membership, as before.
 */

import { useEffect, useRef, useState } from 'react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { redirectToSignIn, useAuth, usesPlatformSignIn } from '@/lib/auth';
import { acceptInvitation, loadPasswordPolicy } from '@/lib/auth/oidc/sign-in-api';
import { useAcceptInvitation } from '@/hooks/queries/use-settings-queries';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { setPendingOrganization } from '@/lib/pending-organization';
import { workspacePath } from '@/lib/workspace-url';
import { ManagedByIdentityProvider } from '@/components/auth/identity-provider-screens';
import {
  DEFAULT_PASSWORD_POLICY,
  meetsPasswordPolicy,
  type PasswordPolicy,
} from '../auth/components/password-requirements';
import { signInErrorCode, signInErrorMessage } from '../auth/components/provider-sign-in';
import { AlreadyUsedView, ExpiredView, PasswordRequiredView, SuccessView } from './invite-views';

/** Set on the way back from the sign-in this page starts: the invitee's account. */
const JOINED_PARAM = 'joined';

/** How long "Welcome!" shows before the browser leaves for the sign-in. */
const WELCOME_MS = 1000;

export interface ProviderInviteClientProps {
  userId?: string;
  code?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  isAuthenticated: boolean;
}

/** `/invite` when Clerk is not the provider. */
export function ProviderInviteClient(props: Readonly<ProviderInviteClientProps>) {
  const joined = new URLSearchParams(window.location.search).get(JOINED_PARAM);
  if (!usesPlatformSignIn()) return <ManagedByIdentityProvider topic="invitations" />;
  if (joined) return <JoinWorkspace orgId={props.orgId} orgName={props.orgName} account={joined} />;
  if (!props.userId || !props.code) return <ManagedByIdentityProvider topic="invitations" />;
  return (
    <AcceptInvitationForm
      userId={props.userId}
      code={props.code}
      orgId={props.orgId}
      orgName={props.orgName}
      email={props.email}
    />
  );
}

/** Open the workspace just joined, and tell the shell to make it the active one. */
function enterWorkspace(orgId: string | undefined) {
  if (orgId) setPendingOrganization(orgId);
  window.location.replace(orgId ? workspacePath(orgId, '/') : '/');
}

function AcceptInvitationForm({
  userId,
  code,
  orgId,
  orgName,
  email,
}: Readonly<{ userId: string; code: string; orgId?: string; orgName?: string; email?: string }>) {
  const t = getTranslations('common');
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [outcome, setOutcome] = useState<'form' | 'accepted' | 'expired' | 'used'>('form');

  // The provider's own rules for the checklist; Global's until they arrive.
  useEffect(() => {
    let current = true;
    loadPasswordPolicy()
      .then((loaded) => {
        if (current) setPolicy(loaded);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meetsPasswordPolicy(password, policy)) {
      setError(t.auth.resetPassword.passwordDoesNotMeetRequirements);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.invite.passwordsDoNotMatch);
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await acceptInvitation({ userId, code: code.trim(), password });
      setOutcome('accepted');
      // The backend's provider session lets this sign-in straight through.
      const back = new URLSearchParams({ [JOINED_PARAM]: userId });
      if (orgId) back.set('org_id', orgId);
      if (orgName) back.set('org_name', orgName);
      window.setTimeout(() => void redirectToSignIn({ returnTo: `/invite?${back.toString()}` }), WELCOME_MS);
    } catch (err) {
      const refusal = signInErrorCode(err);
      if (refusal === 'INVALID_CODE') setOutcome('expired');
      else if (refusal === 'INVITATION_ACCEPTED') setOutcome('used');
      else setError(signInErrorMessage(refusal, t.invite.errors.failedToAcceptInvitation));
      setIsLoading(false);
    }
  };

  if (outcome === 'accepted') return <SuccessView />;
  if (outcome === 'expired') return <ExpiredView orgName={orgName} onHome={() => router.push('/')} />;
  if (outcome === 'used') return <AlreadyUsedView orgName={orgName} onDashboard={() => router.push('/')} />;
  return (
    <PasswordRequiredView
      inviteeEmail={email ?? null}
      inviteeName={null}
      error={error}
      password={password}
      confirmPassword={confirmPassword}
      isLoading={isLoading}
      passwordPolicy={policy}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={(e) => void handleSubmit(e)}
    />
  );
}

/**
 * Back from the sign-in, as the invitee: link the invited member row and open
 * the workspace. A failed link still opens it; the identity sync catches up.
 */
function JoinWorkspace({ orgId, orgName, account }: Readonly<{ orgId?: string; orgName?: string; account: string }>) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const accept = useAcceptInvitation();
  const started = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || started.current) return;
    started.current = true;
    // Matched by the invitee's address: the provider's invitation id is not in the link.
    accept
      .mutateAsync(account)
      .catch(() => undefined)
      .finally(() => enterWorkspace(orgId));
  }, [isLoaded, isSignedIn, accept, account, orgId]);

  if (!isLoaded) return <PageLoader />;
  // The sign-in did not finish: the invitation is accepted all the same.
  if (!isSignedIn) return <AlreadyUsedView orgName={orgName} onDashboard={() => router.push('/')} />;
  return <SuccessView />;
}
