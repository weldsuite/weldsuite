/**
 * The invitation screens, without an invitation behind them: Global's Clerk
 * invite client (`invite-client.tsx`) and the provider invite page on the
 * Kubernetes editions (`provider-invite.tsx`, ADR SEC-016) both render these,
 * so an invitee sees the same screens in every edition.
 */

import { useEffect, useRef } from 'react';
import { Loader2, CheckCircle, XCircle, Lock, Mail, User, Clock, UserCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import {
  meetsPasswordPolicy,
  PasswordRequirementList,
  type PasswordPolicy,
} from '../auth/components/password-requirements';

export function InviteErrorBanner({ error }: Readonly<{ error: string | null }>) {
  if (!error) return null;
  return (
    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
      {error}
    </div>
  );
}

export function LoadingLabel({
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

export function WorkspaceSummary({ orgName }: Readonly<{ orgName?: string }>) {
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

export interface PasswordRequiredViewProps {
  inviteeEmail: string | null;
  inviteeName: string | null;
  error: string | null;
  password: string;
  confirmPassword: string;
  isLoading: boolean;
  /**
   * The identity provider's rules, shown as a checklist under the field.
   * Without them: Clerk's eight characters, as a hint.
   */
  passwordPolicy?: PasswordPolicy;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** "Complete your account": the invitee's first password, typed twice. */
export function PasswordRequiredView({
  inviteeEmail,
  inviteeName,
  error,
  password,
  confirmPassword,
  isLoading,
  passwordPolicy,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: Readonly<PasswordRequiredViewProps>) {
  const t = getTranslations('common');
  const passwordInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    passwordInputRef.current?.focus();
  }, []);
  const passwordOk = passwordPolicy ? meetsPasswordPolicy(password, passwordPolicy) : password.length >= 8;
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
            {/* The account a password manager saves the new password for. */}
            {inviteeEmail && (
              <input type="email" name="username" autoComplete="username" value={inviteeEmail} readOnly hidden />
            )}
            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-900">
                {t.invite.passwordLabel}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-[17px] w-[17px] text-gray-400 pointer-events-none" />
                <input
                  id="password"
                  ref={passwordInputRef}
                  type="password"
                  autoComplete="new-password"
                  placeholder={t.invite.passwordPlaceholder}
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  required
                  disabled={isLoading}
                  className="w-full pl-10 h-[40px] border border-gray-300 bg-white text-gray-900 text-[14px] rounded-lg focus:border-gray-400 focus:outline-none"
                />
              </div>
              {passwordPolicy ? (
                <PasswordRequirementList password={password} policy={passwordPolicy} />
              ) : (
                <p className="text-xs text-gray-500 mt-1">{t.invite.passwordHint}</p>
              )}
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
                  autoComplete="new-password"
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
              disabled={isLoading || !passwordOk || password !== confirmPassword}
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

export function SuccessView() {
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

export function ExpiredView({ orgName, onHome }: Readonly<{ orgName?: string; onHome: () => void }>) {
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

export function AlreadyUsedView({ orgName, onDashboard }: Readonly<{ orgName?: string; onDashboard: () => void }>) {
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

export function TicketErrorView({ error, onLogin }: Readonly<{ error: string | null; onLogin: () => void }>) {
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
