// Covers the shared LoginScreen helpers from @weldsuite/mobile-ui, which has no
// test runner of its own.
import { LOGIN_COPY } from '@weldsuite/mobile-ui/constants/login-copy';
import {
  authErrorMessage,
  isValidEmail,
  passwordErrorMessage,
} from '@weldsuite/mobile-ui/lib/auth-errors';

const copy = LOGIN_COPY.en;
const clerkError = (code: string, status = 422) => ({
  status,
  errors: [{ code, message: `raw ${code}` }],
});

describe('authErrorMessage', () => {
  it('gives an unknown email and a wrong password the same message', () => {
    const unknown = authErrorMessage(clerkError('form_identifier_not_found'), copy.invalidCredentials, copy);
    const wrong = authErrorMessage(clerkError('form_password_incorrect'), copy.invalidCredentials, copy);
    expect(unknown).toBe(copy.invalidCredentials);
    expect(wrong).toBe(unknown);
  });

  it('never passes Clerk messages through', () => {
    expect(authErrorMessage(clerkError('form_param_format_invalid'), copy.invalidCredentials, copy))
      .toBe(copy.invalidCredentials);
    expect(authErrorMessage(new Error('Identifier is invalid.'), copy.invalidCode, copy)).toBe(copy.invalidCode);
  });

  it('keeps rate limiting, lockout and network problems specific', () => {
    expect(authErrorMessage(clerkError('too_many_requests', 429), copy.invalidCredentials, copy))
      .toBe(copy.tooManyAttempts);
    expect(authErrorMessage(clerkError('user_locked', 403), copy.invalidCredentials, copy))
      .toBe(copy.accountLocked);
    expect(authErrorMessage({ code: 'network_error' }, copy.invalidCredentials, copy)).toBe(copy.networkError);
    expect(authErrorMessage(new TypeError('Network request failed'), copy.invalidCredentials, copy))
      .toBe(copy.networkError);
  });
});

describe('passwordErrorMessage', () => {
  it('explains a rejected new password', () => {
    expect(passwordErrorMessage(clerkError('form_password_pwned'), copy)).toBe(copy.passwordCompromised);
    expect(passwordErrorMessage(clerkError('form_password_length_too_short'), copy)).toBe(copy.passwordRequirements);
  });

  it('leaves other errors to authErrorMessage', () => {
    expect(passwordErrorMessage(clerkError('form_code_incorrect'), copy)).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('maestro@weldsuite.org')).toBe(true);
    expect(isValidEmail('  first.last+tag@mail.example.co.uk ')).toBe(true);
  });

  it('rejects what Clerk would call an invalid identifier', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a@b.')).toBe(false);
    expect(isValidEmail('@weldsuite.org')).toBe(false);
    expect(isValidEmail('a b@weldsuite.org')).toBe(false);
    expect(isValidEmail('a@@weldsuite.org')).toBe(false);
  });
});

describe('login copy', () => {
  it('has a Dutch string for every English one', () => {
    expect(Object.keys(LOGIN_COPY.nl).sort()).toEqual(Object.keys(LOGIN_COPY.en).sort());
    expect(LOGIN_COPY.nl.invalidCredentials).not.toBe(LOGIN_COPY.en.invalidCredentials);
  });
});
