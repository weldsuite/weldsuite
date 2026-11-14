
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '@/lib/router';
import { useAuth, ClerkOnly } from '@/lib/auth';
import { useSignIn, useSignUp, useClerk, useClerkOrganizationList, isClerkAPIResponseError } from '@/lib/auth/clerk';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { setPendingOrganization } from '@/lib/pending-organization';
import { workspacePath } from '@/lib/workspace-url';
import { pickInvitation } from './pick-invitation';
import {
  AlreadyUsedView,
  ExpiredView,
  InviteErrorBanner,
  LoadingLabel,
  PasswordRequiredView,
  SuccessView,
  TicketErrorView,
} from './invite-views';
import { ProviderInviteClient } from './provider-invite';

interface InviteClientProps {
  /** The identity provider's invitation (Zitadel): its account and code, from the emailed link. */
  userId?: string;
  code?: string;
  orgId?: string;
  orgName?: string;
  invitationId?: string;
  email?: string;
  isAuthenticated: boolean;
  clerkTicket?: string;
  clerkStatus?: 'sign_in' | 'sign_up';
}

type TicketStatus =
  | 'idle'
  | 'processing'
  | 'password_required'
  | 'success'
  | 'error'
  | 'signed_in_conflict'
  | 'already_member'
  | 'expired'
  | 'used';

type TicketErrorOutcome =
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'password_required' }
  | { status: 'error'; message: string };

const ALREADY_USED_CODES = new Set(['ticket_already_used', 'ticket_already_accepted']);
const ALREADY_USED_MESSAGES = ['already been used', 'already been accepted', 'already accepted'];

// Maps an error thrown while processing a Clerk ticket onto the state to show.
function classifyTicketError(err: unknown): TicketErrorOutcome {
  const firstError = isClerkAPIResponseError(err) ? err.errors[0] : undefined;
  const errorCode = firstError?.code;
  const errorMessage = isClerkAPIResponseError(err)
    ? firstError?.longMessage || firstError?.message || ''
    : '';
  const lowerMessage = errorMessage.toLowerCase();

  // Check if invitation is expired
  if (errorCode === 'ticket_expired' || lowerMessage.includes('expired')) {
    return { status: 'expired' };
  }

  // Check if invitation is already used/accepted
  if (
    (errorCode !== undefined && ALREADY_USED_CODES.has(errorCode)) ||
    ALREADY_USED_MESSAGES.some((fragment) => lowerMessage.includes(fragment))
  ) {
    return { status: 'used' };
  }

  // Check if error indicates we need password
  if (errorCode === 'form_password_required' || lowerMessage.includes('password')) {
    return { status: 'password_required' };
  }

  return { status: 'error', message: errorMessage };
}

// Email and display name of the invitee, as known by the (partial) sign-up.
function getInviteeDetails(
  signUp: { emailAddress?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): { email: string | null; name: string | null } {
  return {
    email: signUp?.emailAddress || null,
    name: [signUp?.firstName, signUp?.lastName].filter(Boolean).join(' ') || null,
  };
}

/**
 * Open the app in the workspace just joined. Clerk's active org can still be
 * the previous one after the reload, so the app shell is told which org to
 * activate. The persisted query cache is kept per workspace (FE-014), so
 * there is nothing of the old org's to drop.
 */
function enterWorkspaceSoon(orgId: string | undefined) {
  if (orgId) setPendingOrganization(orgId);
  setTimeout(() => {
    window.location.href = orgId ? workspacePath(orgId, '/') : '/';
  }, 1500);
}

interface PendingInvitation {
  publicOrganizationData?: { name?: string };
}

interface SignedInConflictViewProps {
  invitation: PendingInvitation | undefined;
  userEmail?: string;
  isLoading: boolean;
  error: string | null;
  onAccept: () => void;
  onSignOut: (redirectUrl: string) => void;
  onCancel: () => void;
}

// Joining while signed in didn't go through on its own: either retry the
// invitation (accepting failed) or the link was for another account (sign out).
function SignedInConflictView({
  invitation,
  userEmail,
  isLoading,
  error,
  onAccept,
  onSignOut,
  onCancel,
}: Readonly<SignedInConflictViewProps>) {
  const t = getTranslations('common');
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  // A pending invitation for this account - show Accept + Cancel
  if (invitation) {
    return (
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="w-full max-w-[448px] mx-auto">
            <div className="mb-[32px]">
              <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
                {t.invite.acceptInvitationTitle}
              </h1>
              <p className="text-gray-600">
                {t.invite.youveBeenInvitedToJoin}{' '}
                <span className="font-medium">{invitation?.publicOrganizationData?.name || t.invite.aWorkspace}</span>
              </p>
            </div>

            <InviteErrorBanner error={error} />

            <div className="space-y-[10px]">
              <Button
                variant="ghost"
                onClick={onAccept}
                disabled={isLoading}
                className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <LoadingLabel isLoading={isLoading} loadingLabel={t.invite.accepting} label={t.invite.acceptInvitation} />
              </Button>
              <Button
                variant="ghost"
                onClick={onCancel}
                disabled={isLoading}
                className="w-full h-[42px] rounded-lg border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 text-[14px] transition-colors"
              >
                {t.invite.cancel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Wrong account - show Sign Out + Cancel
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.wrongAccountTitle}
            </h1>
            <p className="text-gray-600">
              {t.invite.wrongAccountDescription.split('{email}')[0]}
              <span className="font-medium">{userEmail}</span>
              {t.invite.wrongAccountDescription.split('{email}')[1]}
            </p>
          </div>

          <div className="space-y-[10px]">
            <Button
              variant="ghost"
              onClick={() => onSignOut(currentUrl)}
              disabled={isLoading}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <LoadingLabel isLoading={isLoading} loadingLabel={t.invite.signingOut} label={t.invite.signOutAndUseOtherAccount} />
            </Button>
            <Button
              variant="ghost"
              onClick={onCancel}
              disabled={isLoading}
              className="w-full h-[42px] rounded-lg border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 text-[14px] transition-colors"
            >
              {t.invite.cancel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AlreadyMemberViewProps {
  userEmail?: string;
  isLoading: boolean;
  onContinue: () => void;
  onSignOut: (redirectUrl: string) => void;
}

// Signed in with an account that is already in the workspace, and nothing left
// to accept for it: the link may well be for another account (TASK-1065).
function AlreadyMemberView({ userEmail, isLoading, onContinue, onSignOut }: Readonly<AlreadyMemberViewProps>) {
  const t = getTranslations('common');
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  const [before, after] = t.invite.alreadyMemberDescription.split('{email}');

  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.alreadyMemberTitle}
            </h1>
            <p className="text-gray-600">
              {before}
              <span className="font-medium">{userEmail}</span>
              {after}
            </p>
          </div>

          <div className="space-y-[10px]">
            <Button
              variant="ghost"
              onClick={onContinue}
              disabled={isLoading}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {t.invite.continueToWorkspace}
            </Button>
            <Button
              variant="ghost"
              onClick={() => onSignOut(currentUrl)}
              disabled={isLoading}
              className="w-full h-[42px] rounded-lg border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-50 text-[14px] transition-colors flex items-center justify-center gap-2"
            >
              <LoadingLabel isLoading={isLoading} loadingLabel={t.invite.signingOut} label={t.invite.signOutAndUseOtherAccount} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface InvitePreviewProps {
  orgName?: string;
  email?: string;
  isAuthenticated: boolean;
  isLoading: boolean;
  onAccept: () => void;
}

// Default invite preview UI (for non-ticket invitations)
function InvitePreview({ orgName, email, isAuthenticated, isLoading, onAccept }: Readonly<InvitePreviewProps>) {
  const t = getTranslations('common');
  const acceptLabel = isAuthenticated ? t.invite.acceptInvitation : t.invite.acceptAndCreateAccount;
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="max-w-md w-full mx-4">
        <div className="bg-card rounded-lg shadow-lg p-8 text-center space-y-6">
          {/* Logo or Icon */}
          <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
              />
            </svg>
          </div>

          {/* Invitation Message */}
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-foreground">
              {t.invite.youreInvited}
            </h1>
            <p className="text-muted-foreground">
              {orgName ? (
                <>
                  {t.invite.invitedToJoinNamed.split('{orgName}')[0]}
                  <span className="font-medium text-foreground">{orgName}</span>
                  {t.invite.invitedToJoinNamed.split('{orgName}')[1]}
                </>
              ) : (
                t.invite.invitedToJoinWorkspace
              )}
            </p>
          </div>

          {/* Email hint */}
          {email && (
            <div className="text-sm text-muted-foreground bg-muted/50 rounded-md py-2 px-4">
              {t.invite.invitationSentTo} <span className="font-medium">{email}</span>
            </div>
          )}

          {/* Accept Button */}
          <Button
            variant="ghost"
            onClick={onAccept}
            disabled={isLoading}
            className="w-full py-3 px-4 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium h-auto"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                {t.invite.processing}
              </span>
            ) : (
              acceptLabel
            )}
          </Button>

          {/* Additional info */}
          <p className="text-xs text-muted-foreground">
            {isAuthenticated
              ? t.invite.joinWithExistingAccount
              : t.invite.createAccountToContinue}
          </p>
        </div>
      </div>
    </div>
  );
}

function ClerkInviteClient({
  orgId,
  orgName,
  invitationId,
  email,
  isAuthenticated,
  clerkTicket,
  clerkStatus,
}: Readonly<InviteClientProps>) {
  const t = getTranslations('common');
  const [isLoading, setIsLoading] = useState(false);
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteeEmail, setInviteeEmail] = useState<string | null>(null);
  const [inviteeName, setInviteeName] = useState<string | null>(null);
  const router = useRouter();

  const { signIn, setActive: setSignInActive, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: signUpLoaded } = useSignUp();
  const { setActive: setOrgActive, userInvitations, isLoaded: orgListLoaded } = useClerkOrganizationList({
    userInvitations: { infinite: true },
  });
  const { isSignedIn } = useAuth();
  const { signOut, user } = useClerk();

  // Already signed in (say the link was opened from WeldMail): there is no
  // ticket sign-in to do; accept with this account and switch workspace.
  const joinsWhileSignedIn = Boolean(isSignedIn && (clerkTicket || orgId));
  const invitation = pickInvitation(userInvitations?.data, orgId);
  const joinStartedRef = useRef(false);

  // Handle Clerk ticket flow (signed out)
  useEffect(() => {
    if (!clerkTicket || ticketStatus !== 'idle') return;
    if (!signInLoaded || !signUpLoaded) return;
    if (isSignedIn) return;

    const showPasswordRequired = () => {
      // Extract email and name from the signUp object if available
      const invitee = getInviteeDetails(signUp);
      setInviteeEmail(invitee.email);
      setInviteeName(invitee.name);
      setTicketStatus('password_required');
    };

    const failAndRedirectToLogin = (message: string) => {
      setTicketStatus('error');
      setError(message);
      router.push(`/auth/login?__clerk_ticket=${encodeURIComponent(clerkTicket)}`);
    };

    // New user - try to create with ticket first to see if password is needed
    const processSignUpTicket = async (activeSignUp: NonNullable<typeof signUp>) => {
      const result = await activeSignUp.create({
        strategy: 'ticket',
        ticket: clerkTicket,
      });

      if (result.status === 'complete') {
        // No password required (unlikely but possible)
        await setSignUpActive({ session: result.createdSessionId });
        setTicketStatus('success');
        enterWorkspaceSoon(orgId);
      } else if (result.status === 'missing_requirements') {
        // Need additional info (password)
        showPasswordRequired();
      } else {
        setTicketStatus('error');
        setError(t.invite.errors.unableToProcess);
      }
    };

    // Existing user - use sign in flow
    const processSignInTicket = async (activeSignIn: NonNullable<typeof signIn>) => {
      const result = await activeSignIn.create({
        strategy: 'ticket',
        ticket: clerkTicket,
      });

      if (result.status === 'complete') {
        await setSignInActive({ session: result.createdSessionId });
        setTicketStatus('success');
        enterWorkspaceSoon(orgId);
      } else if (result.status === 'needs_second_factor') {
        // User has 2FA enabled, redirect to login with ticket
        failAndRedirectToLogin(t.invite.errors.twoFactorRequired);
      } else if (result.status === 'needs_first_factor') {
        // Need to enter password
        failAndRedirectToLogin(t.invite.errors.signInWithPassword);
      } else {
        failAndRedirectToLogin(t.invite.errors.additionalVerificationRequired);
      }
    };

    const handleTicketError = (err: unknown) => {
      console.error('Clerk ticket error:', err);

      const outcome = classifyTicketError(err);
      if (outcome.status === 'password_required') {
        showPasswordRequired();
      } else if (outcome.status === 'error') {
        setTicketStatus('error');
        setError(outcome.message || t.invite.errors.failedToProcessInvitation);
      } else {
        setTicketStatus(outcome.status);
      }
    };

    const handleClerkTicket = async () => {
      setTicketStatus('processing');
      setError(null);

      try {
        if (clerkStatus === 'sign_up' && signUp) {
          await processSignUpTicket(signUp);
        } else if (signIn) {
          await processSignInTicket(signIn);
        }
      } catch (err: unknown) {
        handleTicketError(err);
      }
    };

    void handleClerkTicket();
  }, [
    clerkTicket,
    clerkStatus,
    orgId,
    signIn,
    signUp,
    signInLoaded,
    signUpLoaded,
    setSignInActive,
    setSignUpActive,
    router,
    ticketStatus,
    isSignedIn,
    t.invite.errors.additionalVerificationRequired,
    t.invite.errors.failedToProcessInvitation,
    t.invite.errors.signInWithPassword,
    t.invite.errors.twoFactorRequired,
    t.invite.errors.unableToProcess,
  ]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!signUp || !clerkTicket) return;

    if (password !== confirmPassword) {
      setError(t.invite.errors.passwordsDoNotMatch);
      return;
    }

    if (password.length < 8) {
      setError(t.invite.errors.passwordTooShort);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Update the sign-up with the password
      const result = await signUp.update({
        password,
      });

      if (result.status === 'complete') {
        await setSignUpActive({ session: result.createdSessionId });
        setTicketStatus('success');
        enterWorkspaceSoon(orgId);
      } else {
        // May need email verification
        if (result.status === 'missing_requirements' &&
            result.unverifiedFields?.includes('email_address')) {
          // Prepare email verification
          await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
          setError(t.invite.errors.checkEmailForCode);
        } else {
          setError(t.invite.errors.unableToCompleteSignUp);
        }
        setIsLoading(false);
      }
    } catch (err: unknown) {
      console.error('Password submit error:', err);
      const errorMessage = isClerkAPIResponseError(err)
        ? err.errors[0]?.longMessage || err.errors[0]?.message || t.invite.errors.failedToCreateAccount
        : t.invite.errors.failedToCreateAccount;
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  const handleAcceptInvitation = () => {
    setIsLoading(true);

    // Build redirect URL with invitation context for after login
    const returnUrl = new URL('/', window.location.origin);
    if (orgId) returnUrl.searchParams.set('org_id', orgId);
    if (invitationId) returnUrl.searchParams.set('invitation_id', invitationId);

    // Redirect to login page with return URL
    const loginUrl = new URL('/auth/login', window.location.origin);
    loginUrl.searchParams.set('redirect_url', returnUrl.pathname + returnUrl.search);
    if (email) loginUrl.searchParams.set('email', email);

    router.push(loginUrl.toString());
  };

  const handleSignOutAndRetry = async (redirectUrl: string) => {
    setIsLoading(true);
    await signOut({ redirectUrl });
  };

  const targetOrgId = invitation?.publicOrganizationData.id ?? orgId;
  const isMemberOfTarget = Boolean(
    targetOrgId && user?.organizationMemberships?.some((m) => m.organization.id === targetOrgId),
  );

  // Signed in: accept the invitation and switch to its workspace. Without a
  // pending invitation for this account the link is for someone else, or was
  // used already: say so instead of switching (TASK-1065). A sign-up link is
  // for an email with no account yet, so never for the signed-in one.
  const joinWorkspace = useCallback(async () => {
    if (!targetOrgId || !setOrgActive || !invitation) {
      setTicketStatus(isMemberOfTarget && clerkStatus !== 'sign_up' ? 'already_member' : 'signed_in_conflict');
      return;
    }

    setTicketStatus('processing');
    setError(null);

    try {
      await invitation.accept();
    } catch (err: unknown) {
      console.error('Accept invitation error:', err);
      setError(
        isClerkAPIResponseError(err)
          ? err.errors[0]?.message || t.invite.errors.failedToAcceptInvitation
          : t.invite.errors.failedToAcceptInvitation,
      );
      setTicketStatus('signed_in_conflict');
      return;
    }

    try {
      await setOrgActive({ organization: targetOrgId });
    } catch {
      // The app shell activates the pending org on reload instead.
    }

    setTicketStatus('success');
    enterWorkspaceSoon(targetOrgId);
  }, [
    invitation,
    targetOrgId,
    isMemberOfTarget,
    clerkStatus,
    setOrgActive,
    t.invite.errors.failedToAcceptInvitation,
  ]);

  // "Continue to workspace" from the already-a-member screen.
  const enterMemberWorkspace = useCallback(async () => {
    if (!targetOrgId || !setOrgActive) return;
    setTicketStatus('processing');
    try {
      await setOrgActive({ organization: targetOrgId });
    } catch {
      setTicketStatus('signed_in_conflict');
      return;
    }
    setTicketStatus('success');
    enterWorkspaceSoon(targetOrgId);
  }, [targetOrgId, setOrgActive]);

  useEffect(() => {
    if (!joinsWhileSignedIn || !orgListLoaded) return;
    if (userInvitations?.isLoading || joinStartedRef.current) return;
    joinStartedRef.current = true;
    void joinWorkspace();
  }, [joinsWhileSignedIn, orgListLoaded, userInvitations?.isLoading, joinWorkspace]);

  // Ticket-driven states only apply when the link carries an invitation to process.
  const activeTicketStatus = clerkTicket || joinsWhileSignedIn ? ticketStatus : undefined;

  // Show processing state for Clerk ticket
  if (activeTicketStatus === 'idle') {
    return (
      <PageLoader label={joinsWhileSignedIn ? t.invite.checkingInvitation : t.invite.loadingInvitation} />
    );
  }

  if (activeTicketStatus === 'processing') {
    return <PageLoader label={t.invite.processingInvitation} />;
  }

  // Show password form for new users
  if (activeTicketStatus === 'password_required') {
    return (
      <PasswordRequiredView
        inviteeEmail={inviteeEmail}
        inviteeName={inviteeName}
        error={error}
        password={password}
        confirmPassword={confirmPassword}
        isLoading={isLoading}
        onPasswordChange={setPassword}
        onConfirmPasswordChange={setConfirmPassword}
        onSubmit={handlePasswordSubmit}
      />
    );
  }

  // Show success state
  if (ticketStatus === 'success') {
    return <SuccessView />;
  }

  // Signed in, but joining didn't go through on its own (accept failed or wrong account)
  if (activeTicketStatus === 'signed_in_conflict') {
    return (
      <SignedInConflictView
        invitation={invitation}
        userEmail={user?.primaryEmailAddress?.emailAddress}
        isLoading={isLoading}
        error={error}
        onAccept={() => void joinWorkspace()}
        onSignOut={handleSignOutAndRetry}
        onCancel={() => router.push('/')}
      />
    );
  }

  if (activeTicketStatus === 'already_member') {
    return (
      <AlreadyMemberView
        userEmail={user?.primaryEmailAddress?.emailAddress}
        isLoading={isLoading}
        onContinue={() => void enterMemberWorkspace()}
        onSignOut={handleSignOutAndRetry}
      />
    );
  }

  // Show expired state
  if (activeTicketStatus === 'expired') {
    return <ExpiredView orgName={orgName} onHome={() => router.push('/')} />;
  }

  // Show already used/accepted state
  if (activeTicketStatus === 'used') {
    return <AlreadyUsedView orgName={orgName} onDashboard={() => router.push('/')} />;
  }

  // Show error state for ticket processing
  if (activeTicketStatus === 'error') {
    return <TicketErrorView error={error} onLogin={() => router.push('/auth/login')} />;
  }

  // Default invite preview UI (for non-ticket invitations)
  return (
    <InvitePreview
      orgName={orgName}
      email={email}
      isAuthenticated={isAuthenticated}
      isLoading={isLoading}
      onAccept={handleAcceptInvitation}
    />
  );
}

/**
 * Invitations are Clerk organization invitations on Global. On an OIDC
 * provider the invitee accepts on the platform's screens where WeldSuite
 * shows its own sign-in, else the provider manages membership.
 */
export function InviteClient(props: Readonly<InviteClientProps>) {
  return (
    <ClerkOnly
      fallback={
        <ProviderInviteClient
          userId={props.userId}
          code={props.code}
          orgId={props.orgId}
          orgName={props.orgName}
          email={props.email}
          isAuthenticated={props.isAuthenticated}
        />
      }
    >
      <ClerkInviteClient {...props} />
    </ClerkOnly>
  );
}
