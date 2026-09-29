
import { useState, useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { useSignIn, useSignUp, useOrganizationList, useAuth, useClerk } from '@clerk/clerk-react';
import { isClerkAPIResponseError } from '@clerk/clerk-react/errors';
import { Loader2, CheckCircle, XCircle, Lock, Mail, User, Clock, UserCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

interface InviteClientProps {
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
  | 'expired'
  | 'used';

type TicketErrorOutcome =
  | { status: 'expired' }
  | { status: 'used' }
  | { status: 'password_required' }
  | { status: 'error'; message: string };

const ALREADY_USED_CODES = ['ticket_already_used', 'ticket_already_accepted'];
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
    (errorCode !== undefined && ALREADY_USED_CODES.includes(errorCode)) ||
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

function redirectHomeSoon() {
  setTimeout(() => {
    window.location.href = '/';
  }, 1500);
}

function InviteErrorBanner({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
      {error}
    </div>
  );
}

function LoadingLabel({
  isLoading,
  loadingLabel,
  label,
}: Readonly<{ isLoading: boolean; loadingLabel: string; label: string }>) {
  if (!isLoading) return <>{label}</>;
  return (
    <>
      <Loader2 className="h-4 w-4 animate-spin" />
      {loadingLabel}
    </>
  );
}

function WorkspaceSummary({ orgName }: Readonly<{ orgName?: string }>) {
  const t = getTranslations('common');
  if (!orgName) return null;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 mb-6">
      <div className="flex justify-between items-center px-4 py-3">
        <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
        <span className="text-[14px] font-medium text-gray-900">{orgName}</span>
      </div>
    </div>
  );
}

interface PasswordRequiredViewProps {
  inviteeEmail: string | null;
  inviteeName: string | null;
  error: string | null;
  password: string;
  confirmPassword: string;
  isLoading: boolean;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

// Password form for new users
function PasswordRequiredView({
  inviteeEmail,
  inviteeName,
  error,
  password,
  confirmPassword,
  isLoading,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: Readonly<PasswordRequiredViewProps>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.completeYourAccount}
            </h1>
            <p className="text-gray-600">
              {t.invite.setPasswordSubtitle}
            </p>
          </div>

          {/* Show invitation details */}
          <div className="mb-6 p-4 bg-gray-50 rounded-xl space-y-3">
            {inviteeEmail && (
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-gray-400" />
                <span className="text-sm text-gray-900">{inviteeEmail}</span>
              </div>
            )}
            {inviteeName && (
              <div className="flex items-center gap-3">
                <User className="h-4 w-4 text-gray-400" />
                <span className="text-sm text-gray-900">{inviteeName}</span>
              </div>
            )}
          </div>

          <InviteErrorBanner error={error} />

          <form onSubmit={onSubmit} className="space-y-[20px]">
            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-900">
                {t.invite.passwordLabel}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <input
                  id="password"
                  type="password"
                  placeholder={t.invite.passwordPlaceholder}
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  autoFocus
                  className="w-full pl-10 h-[40px] border border-gray-300 bg-white text-gray-900 text-[14px] rounded-lg focus:border-gray-400 focus:outline-none"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">{t.invite.passwordHint}</p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="mb-2 block text-sm font-medium text-gray-900">
                {t.invite.confirmPasswordLabel}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <input
                  id="confirmPassword"
                  type="password"
                  placeholder={t.invite.confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => onConfirmPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className="w-full pl-10 h-[40px] border border-gray-300 bg-white text-gray-900 text-[14px] rounded-lg focus:border-gray-400 focus:outline-none"
                />
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t.invite.passwordsDoNotMatch}</p>
              )}
            </div>

            <Button
              type="submit"
              variant="ghost"
              disabled={isLoading || password.length < 8 || password !== confirmPassword}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <LoadingLabel isLoading={isLoading} loadingLabel={t.invite.creatingAccount} label={t.invite.joinWorkspace} />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

function SuccessView() {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="max-w-md w-full mx-4 text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-green-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t.invite.welcomeTitle}
          </h1>
          <p className="text-gray-600">
            {t.invite.successfullyJoined}
          </p>
          <p className="text-sm text-gray-500 mt-2">
            {t.invite.redirectingToDashboard}
          </p>
        </div>
      </div>
    </div>
  );
}

interface PendingInvitation {
  publicOrganizationData?: { name?: string };
}

interface SignedInConflictViewProps {
  orgListLoaded: boolean;
  invitations: PendingInvitation[] | undefined;
  userEmail?: string;
  isLoading: boolean;
  error: string | null;
  onAccept: () => void;
  onSignOut: (redirectUrl: string) => void;
  onCancel: () => void;
}

// The visitor is already signed in: either the right account (accept) or the wrong one (sign out).
function SignedInConflictView({
  orgListLoaded,
  invitations,
  userEmail,
  isLoading,
  error,
  onAccept,
  onSignOut,
  onCancel,
}: Readonly<SignedInConflictViewProps>) {
  const t = getTranslations('common');
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  // Check if user has a pending invitation (means they're the right account)
  const hasPendingInvitation = invitations && invitations.length > 0;
  const isRightAccount = hasPendingInvitation;

  // Show loading while fetching invitations
  if (!orgListLoaded) {
    return <PageLoader label={t.invite.checkingInvitation} />;
  }

  // Right account - show Accept + Cancel
  if (isRightAccount) {
    const invitation = invitations?.[0];
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

function ExpiredView({ orgName, onHome }: Readonly<{ orgName?: string; onHome: () => void }>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-50 mb-6">
              <Clock className="h-8 w-8 text-amber-600" />
            </div>
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.invitationExpiredTitle}
            </h1>
            <p className="text-gray-600">
              {t.invite.invitationExpiredDescription}
            </p>
          </div>

          <WorkspaceSummary orgName={orgName} />

          <Button
            variant="ghost"
            onClick={onHome}
            className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
          >
            {t.invite.goToHome}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AlreadyUsedView({ orgName, onDashboard }: Readonly<{ orgName?: string; onDashboard: () => void }>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-50 mb-6">
              <UserCheck className="h-8 w-8 text-blue-600" />
            </div>
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.invitationAlreadyAcceptedTitle}
            </h1>
            <p className="text-gray-600">
              {t.invite.invitationAlreadyAcceptedDescription}
            </p>
          </div>

          <WorkspaceSummary orgName={orgName} />

          <Button
            variant="ghost"
            onClick={onDashboard}
            className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
          >
            {t.invite.goToDashboard}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TicketErrorView({ error, onLogin }: Readonly<{ error: string | null; onLogin: () => void }>) {
  const t = getTranslations('common');
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-50 mb-6">
              <XCircle className="h-8 w-8 text-red-600" />
            </div>
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.unableToProcessTitle}
            </h1>
            <p className="text-gray-600">
              {error || t.invite.thereWasAnIssue}
            </p>
          </div>

          <Button
            variant="ghost"
            onClick={onLogin}
            className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
          >
            {t.invite.goToLogin}
          </Button>
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
            ) : isAuthenticated ? (
              t.invite.acceptInvitation
            ) : (
              t.invite.acceptAndCreateAccount
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

export function InviteClient({
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
  const { setActive: setOrgActive, userInvitations, isLoaded: orgListLoaded } = useOrganizationList({
    userInvitations: { infinite: true },
  });
  const { isSignedIn } = useAuth();
  const { signOut, user } = useClerk();

  // Handle Clerk ticket flow
  useEffect(() => {
    if (!clerkTicket || ticketStatus !== 'idle') return;
    if (!signInLoaded || !signUpLoaded) return;

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
        redirectHomeSoon();
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
        redirectHomeSoon();
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

      // If user is already signed in, they need to sign out first to accept with a different account
      // or we redirect them to accept the invitation through the org membership flow
      if (isSignedIn) {
        // Redirect to accept invitation through the normal flow
        // The __clerk_ticket approach is for unauthenticated users
        setTicketStatus('signed_in_conflict');
        return;
      }

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

    handleClerkTicket();
  }, [
    clerkTicket,
    clerkStatus,
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
        redirectHomeSoon();
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

  const handleAcceptInvitation = async () => {
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

  const handleAcceptPendingInvitation = async () => {
    setIsLoading(true);
    setError(null);

    try {
      if (userInvitations?.data && userInvitations.data.length > 0) {
        const pendingInvitation = userInvitations.data[0];
        await pendingInvitation.accept();

        // Set the organization as active
        if (setOrgActive) {
          await setOrgActive({ organization: pendingInvitation.publicOrganizationData.id });
        }

        setTicketStatus('success');
        redirectHomeSoon();
      }
    } catch (err: unknown) {
      console.error('Accept invitation error:', err);
      setError(isClerkAPIResponseError(err) ? err.errors[0]?.message || t.invite.errors.failedToAcceptInvitation : t.invite.errors.failedToAcceptInvitation);
      setIsLoading(false);
    }
  };

  // Ticket-driven states only apply when the invite link carries a Clerk ticket.
  const activeTicketStatus = clerkTicket ? ticketStatus : undefined;

  // Show processing state for Clerk ticket
  if (activeTicketStatus === 'idle') {
    return <PageLoader label={t.invite.loadingInvitation} />;
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

  // Show signed-in conflict state - user is already logged in
  if (activeTicketStatus === 'signed_in_conflict') {
    return (
      <SignedInConflictView
        orgListLoaded={orgListLoaded}
        invitations={userInvitations?.data}
        userEmail={user?.primaryEmailAddress?.emailAddress}
        isLoading={isLoading}
        error={error}
        onAccept={handleAcceptPendingInvitation}
        onSignOut={handleSignOutAndRetry}
        onCancel={() => router.push('/')}
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
