/**
 * What a new password must contain, and the checklist under the password
 * field. Global's rules are fixed (Clerk's); on an OIDC provider they are the
 * provider's own, read from `/api/sign-in/password-policy`.
 */

import { CheckCircle } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

export interface PasswordPolicy {
  minLength: number;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
  symbol: boolean;
}

/** Global's rules. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  uppercase: true,
  lowercase: true,
  number: true,
  symbol: false,
};

export interface PasswordRequirement {
  label: string;
  met: boolean;
}

/** Each rule of the policy with whether `password` meets it, in the order shown. */
export function passwordRequirements(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordRequirement[] {
  const t = getTranslations('common').auth.resetPassword.requirements;
  const requirements: PasswordRequirement[] = [
    {
      label: policy.minLength === 8 ? t.atLeast8Chars : t.atLeastChars.replace('{count}', String(policy.minLength)),
      met: password.length >= policy.minLength,
    },
  ];
  if (policy.uppercase) requirements.push({ label: t.oneUppercase, met: /[A-Z]/.test(password) });
  if (policy.lowercase) requirements.push({ label: t.oneLowercase, met: /[a-z]/.test(password) });
  if (policy.number) requirements.push({ label: t.oneNumber, met: /\d/.test(password) });
  if (policy.symbol) requirements.push({ label: t.oneSymbol, met: /[^A-Za-z0-9]/.test(password) });
  return requirements;
}

/** True when `password` meets every rule. */
export function meetsPasswordPolicy(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): boolean {
  return passwordRequirements(password, policy).every((requirement) => requirement.met);
}

/** The checklist: a tick per rule, green once met. */
export function PasswordRequirementList({
  password,
  policy = DEFAULT_PASSWORD_POLICY,
  testId,
}: Readonly<{ password: string; policy?: PasswordPolicy; testId?: string }>) {
  return (
    <div className="mt-2 space-y-1" data-testid={testId}>
      {passwordRequirements(password, policy).map(({ label, met }) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <CheckCircle className={`h-3 w-3 ${met ? 'text-green-500' : 'text-gray-300'}`} />
          <span className={met ? 'text-gray-700' : 'text-gray-400'}>{label}</span>
        </div>
      ))}
    </div>
  );
}
