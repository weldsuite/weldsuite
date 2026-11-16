/**
 * WeldSuite's own sign-in screens on an OIDC provider (ADR SEC-016): the
 * calls behind them.
 *
 * The provider (Zitadel) still owns passwords, second factors and sessions.
 * Its sign-in for the platform's application points at `/auth/login` instead
 * of its own pages, so `/oauth/v2/authorize` lands there with
 * `?authRequest=…`. The screens then talk to the Rust backend's
 * `/api/sign-in/*` (`rust/modules/core-signin`), which drives the provider's
 * session API with its service token and keeps the provider session in an
 * HttpOnly cookie. Every answer is the next step: a form to show, or the
 * provider's callback URL to continue the OIDC redirect on
 * (`/auth/sso-callback`, as with the hosted pages).
 */

import { getAppApiUrl } from '@/lib/api/public-env';

/** How the provider writes a code it emails. */
export interface CodeFormat {
  length: number;
  charset: 'digits' | 'alphanumeric';
}

export type SecondFactor = 'totp' | 'email_code';

export type SignInStep =
  /** Signed in: continue the OIDC redirect on this URL. */
  | { status: 'complete'; redirectUrl: string }
  /** Show the sign-in form (or the sign-up form, when the request asked for it). */
  | {
      status: 'needs_credentials';
      intent: 'sign-in' | 'sign-up';
      loginHint: string | null;
      allowRegister: boolean;
      allowPasswordReset: boolean;
    }
  /** The password was right; a second factor is due. Without `totp` the code was just emailed. */
  | { status: 'needs_second_factor'; factors: SecondFactor[]; email: string; emailCode: CodeFormat }
  /** The account's email address is not verified yet; a code was sent to it. */
  | { status: 'needs_email_verification'; email: string; code: CodeFormat }
  /** Something these screens don't do (a passkey, enrolling a second factor): the provider's own page does. */
  | { status: 'hosted'; url: string }
  /** The provider no longer knows this sign-in; start again. */
  | { status: 'expired' };

export type SignInErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CODE'
  | 'ACCOUNT_LOCKED'
  | 'RATE_LIMITED'
  | 'EMAIL_TAKEN'
  | 'WEAK_PASSWORD'
  | 'SIGN_UP_DISABLED'
  | 'NO_SESSION'
  | 'INVITATION_ACCEPTED'
  | 'VALIDATION_ERROR'
  | 'UNAVAILABLE';

const KNOWN_CODES: ReadonlySet<string> = new Set<SignInErrorCode>([
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'EMAIL_TAKEN',
  'WEAK_PASSWORD',
  'SIGN_UP_DISABLED',
  'NO_SESSION',
  'INVITATION_ACCEPTED',
  'VALIDATION_ERROR',
]);

/** A refusal from `/api/sign-in/*`. `UNAVAILABLE` stands for anything else, an unreachable backend included. */
export class SignInError extends Error {
  readonly code: SignInErrorCode;

  constructor(code: SignInErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SignInError';
    this.code = code;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getAppApiUrl()}/api/sign-in${path}`, {
      method,
      // The provider session lives in a cookie only the backend reads.
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SignInError('UNAVAILABLE');
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; message?: string };
  } | null;
  if (response.ok && payload && 'data' in payload) return payload.data as T;
  const code = payload?.error?.code;
  throw new SignInError(code && KNOWN_CODES.has(code) ? (code as SignInErrorCode) : 'UNAVAILABLE', payload?.error?.message);
}

/** Where this sign-in stands: opens the screen, and continues a session the browser already has. */
export function loadSignInRequest(authRequest: string): Promise<SignInStep> {
  return call('GET', `/request?authRequest=${encodeURIComponent(authRequest)}`);
}

export function signInWithPassword(authRequest: string, email: string, password: string): Promise<SignInStep> {
  return call('POST', '/password', { authRequest, email, password });
}

/** Email the second-factor code to the person who just passed the password check. */
export function sendSecondFactorCode(authRequest: string): Promise<void> {
  return call('POST', '/second-factor/email-code', { authRequest });
}

export function verifySecondFactor(authRequest: string, factor: SecondFactor, code: string): Promise<SignInStep> {
  return call('POST', '/second-factor', { authRequest, factor, code });
}

/** Check the code that verifies the account's email address. */
export function verifyEmailAddress(authRequest: string, code: string): Promise<SignInStep> {
  return call('POST', '/email-verification', { authRequest, code });
}

export function resendEmailVerification(authRequest: string): Promise<void> {
  return call('POST', '/email-verification/resend', { authRequest });
}

/** The link in the verification email: the code alone verifies the address, in any browser. */
export function verifyEmailFromLink(userId: string, code: string): Promise<void> {
  return call('POST', '/email-verification/link', { userId, code });
}

/** What the provider asks of a new password. */
export interface ProviderPasswordPolicy {
  minLength: number;
  uppercase: boolean;
  lowercase: boolean;
  number: boolean;
  symbol: boolean;
}

export function loadPasswordPolicy(): Promise<ProviderPasswordPolicy> {
  return call('GET', '/password-policy');
}

export interface SignUpInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export function signUp(authRequest: string, input: SignUpInput): Promise<SignInStep> {
  return call('POST', '/sign-up', { authRequest, ...input });
}

/** Always resolves for a well-formed address, whether or not an account has it. */
export function requestPasswordReset(email: string): Promise<void> {
  return call('POST', '/password-reset', { email });
}

export interface PasswordResetInput {
  /** The address the code was asked for, or `userId` from the emailed link. */
  email?: string;
  userId?: string;
  code: string;
  password: string;
}

export function confirmPasswordReset(input: PasswordResetInput): Promise<void> {
  return call('POST', '/password-reset/confirm', input);
}

export interface AcceptInvitationInput {
  /** The account the provider made for the invitee, and the code, from the emailed link. */
  userId: string;
  code: string;
  password: string;
}

export interface AcceptedInvitation {
  email: string | null;
  /** The backend opened a provider session: the sign-in that follows needs no password. */
  signedIn: boolean;
}

/**
 * Accept an invitation: the code proves the address and the person's first
 * password is set. `INVALID_CODE` for a wrong or expired code,
 * `INVITATION_ACCEPTED` when the account accepted before.
 */
export function acceptInvitation(input: AcceptInvitationInput): Promise<AcceptedInvitation> {
  return call('POST', '/invitation/accept', input);
}

/** Forget the provider session (the cookie, and the session at the provider). Never rejects. */
export async function endProviderSession(): Promise<void> {
  await call('POST', '/sign-out').catch(() => undefined);
}
