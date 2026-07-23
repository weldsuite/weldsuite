
import { useEffect, useState } from 'react';
import { useRouter } from '@/lib/router';
import { useClerk, useOrganizationList } from '@clerk/clerk-react';
import { Button } from '@weldsuite/ui/components/button';
import { Loader2, CheckCircle, XCircle, Clock, UserCheck } from 'lucide-react';
import { useInvitationDetails, useAcceptInvitation } from '@/hooks/queries/use-settings-queries';
import type { InvitationDetails, AcceptInvitationResult } from '@/lib/api/legacy-types';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

interface AcceptInviteClientProps {
  token: string;
  initialInvitation?: InvitationDetails | null;
  initialError?: string | null;
}

export function AcceptInviteClient({ token, initialInvitation, initialError }: AcceptInviteClientProps) {
  const t = getTranslations('common');
  const router = useRouter();
  const { signOut } = useClerk();
  const { setActive } = useOrganizationList();

  // Fetch invitation details via hook (skipped when initialInvitation is provided)
  const shouldFetch = !initialInvitation && !initialError;
  const { data: fetchedInvitation, error: fetchError, isLoading: isFetching } = useInvitationDetails(token, shouldFetch);

  const acceptMutation = useAcceptInvitation();

  const [status, setStatus] = useState<'loading' | 'preview' | 'accepting' | 'success' | 'error' | 'expired' | 'used'>(() => {
    if (initialError) return 'error';
    if (initialInvitation?.isExpired) return 'expired';
    if (initialInvitation?.isUsed) return 'used';
    if (initialInvitation) return 'preview';
    return 'loading';
  });
  const [invitation, setInvitation] = useState<InvitationDetails | null>(initialInvitation ?? null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [acceptedWorkspace, setAcceptedWorkspace] = useState<AcceptInvitationResult | null>(null);

  // Sync hook-fetched invitation into local state
  useEffect(() => {
    if (!shouldFetch) return;

    if (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : t.invite.errors.failedToLoadDetails);
      setStatus('error');
      return;
    }

    if (fetchedInvitation) {
      setInvitation(fetchedInvitation as InvitationDetails);
      if ((fetchedInvitation as InvitationDetails).isExpired) {
        setStatus('expired');
      } else if ((fetchedInvitation as InvitationDetails).isUsed) {
        setStatus('used');
      } else {
        setStatus('preview');
      }
    } else if (!isFetching) {
      setError(t.invite.errors.failedToLoadDetails);
      setStatus('error');
    }
  }, [fetchedInvitation, fetchError, isFetching, shouldFetch]);

  const handleAcceptInvitation = () => {
    setStatus('accepting');
    setError(null);

    acceptMutation.mutate(token, {
      onSuccess: (result) => {
        const data = result as AcceptInvitationResult;
        setAcceptedWorkspace(data);
        setStatus('success');

        // Switch to the new organization and redirect to dashboard
        setTimeout(async () => {
          try {
            if (setActive) {
              await setActive({ organization: data.workspaceId });
            }
            window.location.href = '/';
          } catch {
            window.location.href = '/';
          }
        }, 1500);
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : t.invite.errors.failedToAcceptInvitation);
        setStatus('error');
      },
    });
  };

  const handleGoHome = () => {
    router.push('/');
  };

  // Loading State
  if (status === 'loading') {
    return <PageLoader label={t.invite.loadingInvitation} />;
  }

  // Accepting State
  if (status === 'accepting') {
    return <PageLoader label={t.invite.joiningWorkspace} />;
  }

  // Success State
  if (status === 'success' && acceptedWorkspace) {
    return (
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="max-w-md w-full mx-auto text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 mb-6">
              <CheckCircle className="h-8 w-8 text-gray-900" />
            </div>
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.welcomeTitle}
            </h1>
            <p className="text-gray-600 mb-2">
              {t.invite.successfullyJoinedNamed.split('{workspaceName}')[0]}
              <span className="font-medium text-gray-900">{acceptedWorkspace.workspaceName}</span>
              {t.invite.successfullyJoinedNamed.split('{workspaceName}')[1]}
            </p>
            <p className="text-sm text-gray-500">
              {t.invite.redirectingToDashboard}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Expired State
  if (status === 'expired') {
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
                {invitation?.expiresAt
                  ? t.invite.invitationExpiredWithDate.replace('{date}', new Date(invitation.expiresAt).toLocaleDateString())
                  : t.invite.invitationExpiredDescription}
              </p>
            </div>

            {invitation && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 mb-6">
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900">{invitation.workspaceName}</span>
                </div>
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.invitedAsLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900 capitalize">{invitation.role}</span>
                </div>
              </div>
            )}

            <Button
              onClick={handleGoHome}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+3px)] bg-black hover:bg-black/90 text-white"
              size="lg"
            >
              {t.invite.goToHome}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Already Used State
  if (status === 'used') {
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

            {invitation && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-100 mb-6">
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900">{invitation.workspaceName}</span>
                </div>
              </div>
            )}

            <Button
              onClick={handleGoHome}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+3px)] bg-black hover:bg-black/90 text-white"
              size="lg"
            >
              {t.invite.goToDashboard}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Error State
  if (status === 'error') {
    return (
      <div className="min-h-screen bg-white flex relative">
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
          <div className="w-full max-w-[448px] mx-auto">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-50 mb-6">
                <XCircle className="h-8 w-8 text-red-600" />
              </div>
              <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
                {t.invite.unableToAcceptTitle}
              </h1>
              <p className="text-gray-600">
                {error}
              </p>
            </div>

            <Button
              onClick={handleGoHome}
              className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+3px)] bg-black hover:bg-black/90 text-white"
              size="lg"
            >
              {t.invite.goToHome}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Preview State
  return (
    <div className="min-h-screen bg-white flex relative">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          <div className="mb-[32px]">
            <h1 className="text-[26px] font-semibold text-gray-900 mb-2">
              {t.invite.youreInvited}
            </h1>
            <p className="text-gray-600">
              {t.invite.invitedToJoinPreview}
            </p>
          </div>

          {invitation && (
            <div className="space-y-[25px]">
              <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.workspaceLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900">{invitation.workspaceName}</span>
                </div>
                <div className="flex justify-between items-center px-4 py-3">
                  <span className="text-[14px] text-gray-500">{t.invite.yourRoleLabel}</span>
                  <span className="text-[14px] font-medium text-gray-900 capitalize">{invitation.role}</span>
                </div>
                {invitation.expiresAt && (
                  <div className="flex justify-between items-center px-4 py-3">
                    <span className="text-[14px] text-gray-500">{t.invite.invitationExpiresLabel}</span>
                    <span className="text-[14px] text-gray-900">{new Date(invitation.expiresAt).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              <div className="space-y-[10px]">
                <Button
                  onClick={handleAcceptInvitation}
                  disabled={acceptMutation.isPending}
                  className="w-full h-[42px] shadow-none rounded-[calc(var(--radius)+3px)] bg-black hover:bg-black/90 text-white text-[14px]"
                  size="lg"
                >
                  {acceptMutation.isPending ? (
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
                  onClick={handleGoHome}
                  disabled={acceptMutation.isPending}
                  className="w-full h-[42px] rounded-[calc(var(--radius)+3px)] text-[14px] text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
                >
                  {t.invite.declineInvitation}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-sm text-gray-600">
          {t.invite.wrongAccount}{' '}
          <Button
            variant="ghost"
            onClick={() => signOut({ redirectUrl: `/invite/accept?token=${token}` })}
            className="text-gray-900 hover:text-gray-700 font-medium"
          >
            {t.invite.signOut}
          </Button>
        </p>
      </div>
    </div>
  );
}
