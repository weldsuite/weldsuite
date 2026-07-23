
import { useState, useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { useSignIn, useSignUp, useOrganizationList, useAuth, useClerk } from '@clerk/clerk-react';
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

export function InviteClient({
  orgId,
  orgName,
  invitationId,
  email,
  isAuthenticated,
  clerkTicket,
  clerkStatus,
}: InviteClientProps) {
  const t = getTranslations('common');
  const [isLoading, setIsLoading] = useState(false);
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'processing' | 'password_required' | 'success' | 'error' | 'signed_in_conflict' | 'expired' | 'used'>('idle');
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
          // New user - try to create with ticket first to see if password is needed
          const result = await signUp.create({
            strategy: 'ticket',
            ticket: clerkTicket,
          });

          if (result.status === 'complete') {
            // No password required (unlikely but possible)
            await setSignUpActive({ session: result.createdSessionId });
            setTicketStatus('success');
            setTimeout(() => {
              window.location.href = '/';
            }, 1500);
          } else if (result.status === 'missing_requirements') {
            // Need additional info (password)
            // Extract email and name from the signUp object if available
            setInviteeEmail(signUp.emailAddress || null);
            setInviteeName([signUp.firstName, signUp.lastName].filter(Boolean).join(' ') || null);
            setTicketStatus('password_required');
          } else {
            setTicketStatus('error');
            setError(t.invite.errors.unableToProcess);
          }
        } else if (signIn) {
          // Existing user - use sign in flow
          const result = await signIn.create({
            strategy: 'ticket',
            ticket: clerkTicket,
          });

          if (result.status === 'complete') {
            await setSignInActive({ session: result.createdSessionId });
            setTicketStatus('success');
            setTimeout(() => {
              window.location.href = '/';
            }, 1500);
          } else if (result.status === 'needs_second_factor') {
            // User has 2FA enabled, redirect to login with ticket
            setTicketStatus('error');
            setError(t.invite.errors.twoFactorRequired);
            router.push(`/auth/login?__clerk_ticket=${encodeURIComponent(clerkTicket)}`);
          } else if (result.status === 'needs_first_factor') {
            // Need to enter password
            setTicketStatus('error');
            setError(t.invite.errors.signInWithPassword);
            router.push(`/auth/login?__clerk_ticket=${encodeURIComponent(clerkTicket)}`);
          } else {
            setTicketStatus('error');
            setError(t.invite.errors.additionalVerificationRequired);
            router.push(`/auth/login?__clerk_ticket=${encodeURIComponent(clerkTicket)}`);
          }
        }
      } catch (err: any) {
        console.error('Clerk ticket error:', err);

        const errorCode = err?.errors?.[0]?.code;
        const errorMessage = err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || '';

        // Check if invitation is expired
        if (errorCode === 'ticket_expired' ||
            errorMessage.toLowerCase().includes('expired')) {
          setTicketStatus('expired');
          return;
        }

        // Check if invitation is already used/accepted
        if (errorCode === 'ticket_already_used' ||
            errorCode === 'ticket_already_accepted' ||
            errorMessage.toLowerCase().includes('already been used') ||
            errorMessage.toLowerCase().includes('already been accepted') ||
            errorMessage.toLowerCase().includes('already accepted')) {
          setTicketStatus('used');
          return;
        }

        // Check if error indicates we need password
        if (errorCode === 'form_password_required' ||
            errorMessage.toLowerCase().includes('password')) {
          setInviteeEmail(signUp?.emailAddress || null);
          setInviteeName([signUp?.firstName, signUp?.lastName].filter(Boolean).join(' ') || null);
          setTicketStatus('password_required');
        } else {
          setTicketStatus('error');
          setError(errorMessage || t.invite.errors.failedToProcessInvitation);
        }
      }
    };

    handleClerkTicket();
  }, [clerkTicket, clerkStatus, signIn, signUp, signInLoaded, signUpLoaded, setSignInActive, setSignUpActive, router, ticketStatus, isSignedIn]);

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
        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
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
    } catch (err: any) {
      console.error('Password submit error:', err);
      const errorMessage = err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || t.invite.errors.failedToCreateAccount;
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

  // Show processing state for Clerk ticket
  if (clerkTicket && ticketStatus === 'idle') {
    return <PageLoader label={t.invite.loadingInvitation} />;
  }

  if (clerkTicket && ticketStatus === 'processing') {
    return <PageLoader label={t.invite.processingInvitation} />;
  }

  // Show password form for new users
  if (clerkTicket && ticketStatus === 'password_required') {
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

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
                {error}
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-[20px]">
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
                    onChange={(e) => setPassword(e.target.value)}
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
                    onChange={(e) => setConfirmPassword(e.target.value)}
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
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.invite.creatingAccount}
                  </>
                ) : (
                  t.invite.joinWorkspace
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Show success state
  if (ticketStatus === 'success') {
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

  // Show signed-in conflict state - user is already logged in
  if (clerkTicket && ticketStatus === 'signed_in_conflict') {
    const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

    // Check if user has a pending invitation (means they're the right account)
    const hasPendingInvitation = userInvitations?.data && userInvitations.data.length > 0;
    const isRightAccount = hasPendingInvitation;

    const handleSignOutAndRetry = async () => {
      setIsLoading(true);
      await signOut({ redirectUrl: currentUrl });
    };

    const handleAcceptInvitation = async () => {
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
          setTimeout(() => {
            window.location.href = '/';
          }, 1500);
        }
      } catch (err: any) {
        console.error('Accept invitation error:', err);
        setError(err?.errors?.[0]?.message || t.invite.errors.failedToAcceptInvitation);
        setIsLoading(false);
      }
    };

    const handleCancel = () => {
      router.push('/');
    };

    // Show loading while fetching invitations
    if (!orgListLoaded) {
      return <PageLoader label={t.invite.checkingInvitation} />;
    }

    // Right account - show Accept + Cancel
    if (isRightAccount) {
      const invitation = userInvitations?.data?.[0];
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

              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
                  {error}
                </div>
              )}

              <div className="space-y-[10px]">
                <Button
                  variant="ghost"
                  onClick={handleAcceptInvitation}
                  disabled={isLoading}
                  className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t.invite.accepting}
                    </>
                  ) : (
                    t.invite.acceptInvitation
                  )}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleCancel}
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
                <span className="font-medium">{user?.primaryEmailAddress?.emailAddress}</span>
                {t.invite.wrongAccountDescription.split('{email}')[1]}
              </p>
            </div>

            <div className="space-y-[10px]">
              <Button
                variant="ghost"
                onClick={handleSignOutAndRetry}
                disabled={isLoading}
                className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.invite.signingOut}
                  </>
                ) : (
                  t.invite.signOutAndUseOtherAccount
                )}
              </Button>
              <Button
                variant="ghost"
                onClick={handleCancel}
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

  // Show expired state
  if (clerkTicket && ticketStatus === 'expired') {
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

            {orgName && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 mb-6">
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900">{orgName}</span>
                </div>
              </div>
            )}

            <Button
              variant="ghost"
              onClick={() => router.push('/')}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
            >
              {t.invite.goToHome}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show already used/accepted state
  if (clerkTicket && ticketStatus === 'used') {
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

            {orgName && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 mb-6">
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900">{orgName}</span>
                </div>
              </div>
            )}

            <Button
              variant="ghost"
              onClick={() => router.push('/')}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
            >
              {t.invite.goToDashboard}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show error state for ticket processing
  if (clerkTicket && ticketStatus === 'error') {
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
              onClick={() => router.push('/auth/login')}
              className="w-full h-[42px] rounded-lg bg-black hover:bg-black/90 text-white text-[14px] font-medium"
            >
              {t.invite.goToLogin}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Default invite preview UI (for non-ticket invitations)
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
            onClick={handleAcceptInvitation}
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
