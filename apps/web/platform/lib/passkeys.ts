import { isClerkRuntimeError } from '@clerk/clerk-react/errors';

/**
 * Passkey (WebAuthn) helpers shared by the login page and Settings → Security.
 * The ceremonies themselves run through Clerk (`signIn.authenticateWithPasskey`,
 * `user.createPasskey`); this file only answers "can this browser do it" and
 * "what kind of failure was that".
 */

/** Whether this browser exposes the WebAuthn API at all. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/**
 * Whether the browser can offer passkeys in the email field's autofill
 * dropdown (WebAuthn conditional mediation).
 */
export async function isPasskeyAutofillSupported(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    return (await window.PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/** The WebAuthn failure codes Clerk raises from its passkey ceremonies. */
export type PasskeyErrorCode =
  | 'passkey_not_supported'
  | 'passkey_pa_not_supported'
  | 'passkey_invalid_rpID_or_domain'
  | 'passkey_already_exists'
  | 'passkey_operation_aborted'
  | 'passkey_retrieval_cancelled'
  | 'passkey_retrieval_failed'
  | 'passkey_registration_cancelled'
  | 'passkey_registration_failed';

/** The Clerk WebAuthn error code of `err`, or null for anything else. */
export function getPasskeyErrorCode(err: unknown): PasskeyErrorCode | null {
  // Clerk's type guards throw on null/undefined, so only hand them objects.
  if (typeof err !== 'object' || err === null || !isClerkRuntimeError(err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('passkey_') ? (code as PasskeyErrorCode) : null;
}

/**
 * True when the user dismissed the browser's passkey prompt, or the request
 * was superseded by another one (e.g. the autofill request is aborted when
 * the user clicks "Sign in with a passkey"). Neither deserves an error message.
 */
export function isPasskeyDismissed(err: unknown): boolean {
  const code = getPasskeyErrorCode(err);
  if (
    code === 'passkey_operation_aborted' ||
    code === 'passkey_retrieval_cancelled' ||
    code === 'passkey_registration_cancelled'
  ) {
    return true;
  }
  // Raw DOMExceptions can surface when the browser rejects before Clerk wraps them.
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError');
}
