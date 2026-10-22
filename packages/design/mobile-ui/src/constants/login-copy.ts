/**
 * Copy for the shared LoginScreen, in every language the mobile apps ship.
 * An app picks a catalog with `language` and can still override single
 * strings through `copy`.
 */

export interface LoginScreenCopy {
  signInTitle: string;
  subtitle: string;
  emailPlaceholder: string;
  passwordPlaceholder: string;
  forgotPassword: string;
  signIn: string;
  or: string;
  hidePassword: string;
  showPassword: string;
  continueGoogle: string;
  continueApple: string;
  continuePasskey: string;
  twoStepTitle: string;
  totpHint: string;
  phoneHint: string;
  phoneFallback: string;
  backupHint: string;
  backupCodePlaceholder: string;
  verificationCodePlaceholder: string;
  verify: string;
  useAuthenticator: string;
  sendSms: string;
  useBackup: string;
  backToSignIn: string;
  enterEmail: string;
  invalidEmail: string;
  enterPassword: string;
  noAccount: string;
  googleFailed: string;
  appleFailed: string;
  passkeyFailed: string;
  /** @deprecated No longer shown: a failed sign-in reports once, in the form. */
  loginFailed: string;
  invalidCredentials: string;
  tooManyAttempts: string;
  accountLocked: string;
  networkError: string;
  enterCode: string;
  invalidCode: string;
  sendCodeFailed: string;
  // Forgot / reset password
  forgotTitle: string;
  forgotSubtitle: string;
  sendResetCode: string;
  resetTitle: string;
  resetSubtitle: string;
  resetCodePlaceholder: string;
  newPasswordPlaceholder: string;
  confirmPasswordPlaceholder: string;
  resetPassword: string;
  passwordsDoNotMatch: string;
  passwordRequirements: string;
  passwordCompromised: string;
  passwordResetFailed: string;
  invalidResetCode: string;
}

export type LoginLanguage = 'en' | 'nl';

const en: LoginScreenCopy = {
  signInTitle: 'Sign in to your account',
  subtitle: 'Enter your credentials to access your workspace',
  emailPlaceholder: 'Email address',
  passwordPlaceholder: 'Password',
  forgotPassword: 'Forgot password?',
  signIn: 'Sign In',
  or: 'or',
  hidePassword: 'Hide password',
  showPassword: 'Show password',
  continueGoogle: 'Continue with Google',
  continueApple: 'Continue with Apple',
  continuePasskey: 'Sign in with a passkey',
  twoStepTitle: 'Two-step verification',
  totpHint: 'Enter the 6-digit code from your authenticator app.',
  phoneHint: 'Enter the code we sent to {phone}.',
  phoneFallback: 'your phone',
  backupHint: 'Enter one of your backup codes.',
  backupCodePlaceholder: 'Backup code',
  verificationCodePlaceholder: 'Verification code',
  verify: 'Verify',
  useAuthenticator: 'Use authenticator app',
  sendSms: 'Send code via SMS',
  useBackup: 'Use a backup code',
  backToSignIn: 'Back to sign in',
  enterEmail: 'Please enter your email',
  invalidEmail: 'Enter a valid email address',
  enterPassword: 'Please enter your password',
  noAccount: 'No account found. Please create an account at app.weldsuite.org first.',
  googleFailed: 'Google sign in failed',
  appleFailed: 'Apple sign in failed',
  passkeyFailed: "Couldn't sign in with a passkey. Check that one is saved for your account, or sign in another way.",
  loginFailed: 'Login failed',
  invalidCredentials: 'Invalid email or password',
  tooManyAttempts: 'Too many attempts. Wait a moment and try again.',
  accountLocked: 'Too many failed attempts. Your account is locked for now, try again later.',
  networkError: "Couldn't reach the server. Check your connection and try again.",
  enterCode: 'Please enter the verification code',
  invalidCode: 'Invalid verification code',
  sendCodeFailed: 'Failed to send verification code',
  forgotTitle: 'Forgot your password?',
  forgotSubtitle: "Enter your email and we'll send you a code to reset your password.",
  sendResetCode: 'Send Reset Code',
  resetTitle: 'Reset your password',
  resetSubtitle: 'Enter the code from your email and create a new password.',
  resetCodePlaceholder: 'Reset code',
  newPasswordPlaceholder: 'New password',
  confirmPasswordPlaceholder: 'Confirm new password',
  resetPassword: 'Reset Password',
  passwordsDoNotMatch: 'Passwords do not match',
  passwordRequirements: 'Use at least 8 characters with upper, lower, and a number',
  passwordCompromised: 'This password has appeared in a data breach. Choose a different one.',
  passwordResetFailed: 'Password reset failed. Please try again.',
  invalidResetCode: 'Invalid code or password reset failed',
};

const nl: LoginScreenCopy = {
  signInTitle: 'Log in op je account',
  subtitle: 'Vul je gegevens in om je werkruimte te openen',
  emailPlaceholder: 'E-mailadres',
  passwordPlaceholder: 'Wachtwoord',
  forgotPassword: 'Wachtwoord vergeten?',
  signIn: 'Inloggen',
  or: 'of',
  hidePassword: 'Wachtwoord verbergen',
  showPassword: 'Wachtwoord tonen',
  continueGoogle: 'Doorgaan met Google',
  continueApple: 'Doorgaan met Apple',
  continuePasskey: 'Inloggen met een passkey',
  twoStepTitle: 'Tweestapsverificatie',
  totpHint: 'Voer de 6-cijferige code uit je authenticator-app in.',
  phoneHint: 'Voer de code in die we naar {phone} hebben gestuurd.',
  phoneFallback: 'je telefoon',
  backupHint: 'Voer een van je back-upcodes in.',
  backupCodePlaceholder: 'Back-upcode',
  verificationCodePlaceholder: 'Verificatiecode',
  verify: 'Verifiëren',
  useAuthenticator: 'Authenticator-app gebruiken',
  sendSms: 'Code via sms versturen',
  useBackup: 'Back-upcode gebruiken',
  backToSignIn: 'Terug naar inloggen',
  enterEmail: 'Vul je e-mailadres in',
  invalidEmail: 'Vul een geldig e-mailadres in',
  enterPassword: 'Vul je wachtwoord in',
  noAccount: 'Geen account gevonden. Maak eerst een account aan op app.weldsuite.org.',
  googleFailed: 'Inloggen met Google mislukt',
  appleFailed: 'Inloggen met Apple mislukt',
  passkeyFailed: 'Inloggen met een passkey is niet gelukt. Controleer of er een passkey voor je account is opgeslagen, of log op een andere manier in.',
  loginFailed: 'Inloggen mislukt',
  invalidCredentials: 'Ongeldig e-mailadres of wachtwoord',
  tooManyAttempts: 'Te veel pogingen. Wacht even en probeer het opnieuw.',
  accountLocked: 'Te veel mislukte pogingen. Je account is tijdelijk geblokkeerd, probeer het later opnieuw.',
  networkError: 'Kan de server niet bereiken. Controleer je verbinding en probeer het opnieuw.',
  enterCode: 'Voer de verificatiecode in',
  invalidCode: 'Ongeldige verificatiecode',
  sendCodeFailed: 'Verificatiecode versturen mislukt',
  forgotTitle: 'Wachtwoord vergeten?',
  forgotSubtitle: 'Vul je e-mailadres in en we sturen je een code om je wachtwoord te resetten.',
  sendResetCode: 'Resetcode versturen',
  resetTitle: 'Wachtwoord resetten',
  resetSubtitle: 'Voer de code uit je e-mail in en kies een nieuw wachtwoord.',
  resetCodePlaceholder: 'Resetcode',
  newPasswordPlaceholder: 'Nieuw wachtwoord',
  confirmPasswordPlaceholder: 'Bevestig nieuw wachtwoord',
  resetPassword: 'Wachtwoord resetten',
  passwordsDoNotMatch: 'Wachtwoorden komen niet overeen',
  passwordRequirements: 'Minstens 8 tekens met hoofdletter, kleine letter en een cijfer',
  passwordCompromised: 'Dit wachtwoord komt voor in een datalek. Kies een ander wachtwoord.',
  passwordResetFailed: 'Wachtwoord resetten mislukt. Probeer het opnieuw.',
  invalidResetCode: 'Ongeldige code of wachtwoord resetten mislukt',
};

export const LOGIN_COPY: Record<LoginLanguage, LoginScreenCopy> = { en, nl };
