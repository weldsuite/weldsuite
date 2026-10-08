import { describe, expect, it } from 'vitest';
import { getPasskeyErrorCode, isPasskeyDismissed } from './passkeys';

// Stand-in for Clerk's ClerkWebAuthnError: Clerk's type guards recognise
// runtime errors by the constructor's static `kind`.
class FakeClerkRuntimeError extends Error {
  static kind = 'ClerkRuntimeError';
  constructor(readonly code: string) {
    super('passkey failure');
  }
}
const webAuthnError = (code: string) => new FakeClerkRuntimeError(code);

describe('getPasskeyErrorCode', () => {
  it('returns the code of a Clerk WebAuthn error', () => {
    expect(getPasskeyErrorCode(webAuthnError('passkey_already_exists'))).toBe('passkey_already_exists');
  });

  it('ignores other Clerk runtime errors and plain errors', () => {
    expect(getPasskeyErrorCode(webAuthnError('network_error'))).toBeNull();
    expect(getPasskeyErrorCode(new Error('boom'))).toBeNull();
    expect(getPasskeyErrorCode(undefined)).toBeNull();
    expect(getPasskeyErrorCode(null)).toBeNull();
    expect(getPasskeyErrorCode('passkey_already_exists')).toBeNull();
  });
});

describe('isPasskeyDismissed', () => {
  it.each(['passkey_operation_aborted', 'passkey_retrieval_cancelled', 'passkey_registration_cancelled'])(
    'treats %s as a dismissal',
    (code) => {
      expect(isPasskeyDismissed(webAuthnError(code))).toBe(true);
    },
  );

  it('treats raw abort / not-allowed DOMExceptions as a dismissal', () => {
    expect(isPasskeyDismissed(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isPasskeyDismissed(new DOMException('denied', 'NotAllowedError'))).toBe(true);
  });

  it('reports real failures', () => {
    expect(isPasskeyDismissed(webAuthnError('passkey_retrieval_failed'))).toBe(false);
    expect(isPasskeyDismissed(webAuthnError('passkey_already_exists'))).toBe(false);
    expect(isPasskeyDismissed(new Error('boom'))).toBe(false);
  });
});
