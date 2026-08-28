import React, { useState, useCallback, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
  Text,
  type TextInputProps,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useClerk, useAuth, useSSO, useOrganizationList } from '@clerk/expo';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { Eye, EyeOff } from 'lucide-react-native';

WebBrowser.maybeCompleteAuthSession();
import { Colors, Radii, Spacing } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';
import { useToast } from '../contexts/ToastContext';

type ThemeColors = typeof Colors.light;

/** White label on brand-colored CTAs — independent of light/dark primaryForeground. */
const ACCENT_FOREGROUND = '#FFFFFF';

/** ~12% tint of an accent, matching WeldBooks icon tiles. */
function tint(hex: string, fallback: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return fallback;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}

/** Android Custom Tabs drop the OAuth return if the browser isn't warmed up. */
function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

function ssoRedirectUrl() {
  return AuthSession.makeRedirectUri({ path: 'sso-callback' });
}

type SsoResult = {
  createdSessionId: string | null;
  setActive?: (params: { session: string }) => Promise<void>;
  signIn?: { status?: string | null; createdSessionId?: string | null } | null;
  signUp?: { status?: string | null; createdSessionId?: string | null } | null;
};

async function activateSsoSession(
  result: SsoResult,
  onOrgSelect: () => Promise<void>,
): Promise<boolean> {
  const sessionId =
    result.createdSessionId ||
    (result.signIn?.status === 'complete' ? result.signIn.createdSessionId : null) ||
    (result.signUp?.status === 'complete' ? result.signUp.createdSessionId : null);

  if (!sessionId || !result.setActive) return false;
  await result.setActive({ session: sessionId });
  await onOrgSelect();
  return true;
}

// Silent error boundary — hides children if a hook throws during render
class OAuthErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('OAuth provider unavailable:', error.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

function LoginField({
  accentColor,
  colors,
  rightElement,
  ...rest
}: TextInputProps & {
  accentColor: string;
  colors: ThemeColors;
  rightElement?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.field,
        {
          backgroundColor: colors.inputBackground,
          borderColor: focused ? accentColor : 'transparent',
        },
      ]}
    >
      <TextInput
        {...rest}
        placeholderTextColor={colors.placeholder}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[styles.fieldInput, { color: colors.text }, rightElement ? styles.fieldInputWithIcon : null]}
      />
      {rightElement}
    </View>
  );
}

function PasswordToggle({
  show,
  onToggle,
  hideLabel,
  showLabel,
  color,
}: {
  show: boolean;
  onToggle: () => void;
  hideLabel: string;
  showLabel: string;
  color: string;
}) {
  return (
    <TouchableOpacity
      style={styles.passwordToggle}
      onPress={onToggle}
      activeOpacity={0.7}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={show ? hideLabel : showLabel}
    >
      {show ? <Eye size={18} color={color} /> : <EyeOff size={18} color={color} />}
    </TouchableOpacity>
  );
}

// Google button — uses useSSO (Clerk managed OAuth redirect, no client ID needed)
function GoogleSignInButton({
  onOrgSelect,
  disabled,
  isLoading,
  setIsLoading,
  setFormError,
  noAccount,
  googleFailed,
  continueGoogle,
  colors,
}: {
  onOrgSelect: () => Promise<void>;
  disabled: boolean;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
  setFormError: (v: string | null) => void;
  noAccount: string;
  googleFailed: string;
  continueGoogle: string;
  colors: ThemeColors;
}) {
  const { startSSOFlow } = useSSO();
  const toast = useToast();

  const onPress = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    setFormError(null);
    try {
      const result = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: ssoRedirectUrl(),
      });
      if (!(await activateSsoSession(result, onOrgSelect))) {
        setFormError(noAccount);
      }
    } catch (e: any) {
      if (e.code === 'SIGN_IN_CANCELLED' || e.code === '-5' || e.code === 'ERR_REQUEST_CANCELED') return;
      const isNoAccount = e.errors?.some((err: any) =>
        err.code === 'external_account_not_found' || err.code === 'identifier_not_found'
      );
      if (isNoAccount) {
        setFormError(noAccount);
      } else {
        console.error('Google sign in error:', JSON.stringify(e, null, 2));
        const errorMessage = e.errors?.[0]?.message || e.message || googleFailed;
        setFormError(errorMessage);
        toast.error(googleFailed);
      }
    } finally {
      setIsLoading(false);
    }
  }, [startSSOFlow, isLoading, toast, onOrgSelect, setIsLoading, setFormError, noAccount, googleFailed]);

  return (
    <TouchableOpacity
      style={[styles.oauthButton, { backgroundColor: colors.secondary }, isLoading && styles.buttonDisabled]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled || isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <View style={styles.oauthButtonContent}>
          <Image
            source={{ uri: 'https://developers.google.com/identity/images/g-logo.png' }}
            style={styles.oauthIcon}
          />
          <Text style={[styles.oauthButtonText, { color: colors.text }]}>
            {continueGoogle}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Apple button — uses useSSO (Clerk managed OAuth redirect, no client ID needed)
function AppleSignInButton({
  onOrgSelect,
  disabled,
  isLoading,
  setIsLoading,
  setFormError,
  noAccount,
  appleFailed,
  continueApple,
  colors,
}: {
  onOrgSelect: () => Promise<void>;
  disabled: boolean;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
  setFormError: (v: string | null) => void;
  noAccount: string;
  appleFailed: string;
  continueApple: string;
  colors: ThemeColors;
}) {
  const { startSSOFlow } = useSSO();
  const toast = useToast();

  const onPress = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    setFormError(null);
    try {
      const result = await startSSOFlow({
        strategy: 'oauth_apple',
        redirectUrl: ssoRedirectUrl(),
      });
      if (!(await activateSsoSession(result, onOrgSelect))) {
        setFormError(noAccount);
      }
    } catch (e: any) {
      if (e.code === 'ERR_REQUEST_CANCELED') return;
      const isNoAccount = e.errors?.some((err: any) =>
        err.code === 'external_account_not_found' || err.code === 'identifier_not_found'
      );
      if (isNoAccount) {
        setFormError(noAccount);
      } else {
        console.error('Apple sign in error:', JSON.stringify(e, null, 2));
        const errorMessage = e.errors?.[0]?.message || e.message || appleFailed;
        setFormError(errorMessage);
        toast.error(appleFailed);
      }
    } finally {
      setIsLoading(false);
    }
  }, [startSSOFlow, isLoading, toast, onOrgSelect, setIsLoading, setFormError, noAccount, appleFailed]);

  return (
    <TouchableOpacity
      style={[styles.oauthButton, { backgroundColor: colors.secondary }, isLoading && styles.buttonDisabled]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled || isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <View style={styles.oauthButtonContent}>
          <Text style={[styles.appleIcon, { color: colors.text }]}>{'\uF8FF'}</Text>
          <Text style={[styles.oauthButtonText, { color: colors.text }]}>
            {continueApple}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

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
  enterPassword: string;
  noAccount: string;
  googleFailed: string;
  appleFailed: string;
  loginFailed: string;
  invalidCredentials: string;
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
  passwordResetFailed: string;
  invalidResetCode: string;
}

const DEFAULT_COPY: LoginScreenCopy = {
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
  enterPassword: 'Please enter your password',
  noAccount: 'No account found. Please create an account at app.weldsuite.org first.',
  googleFailed: 'Google sign in failed',
  appleFailed: 'Apple sign in failed',
  loginFailed: 'Login failed',
  invalidCredentials: 'Invalid email or password',
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
  passwordResetFailed: 'Password reset failed. Please try again.',
  invalidResetCode: 'Invalid code or password reset failed',
};

export interface LoginScreenProps {
  /** Custom logo element (e.g. an SVG wordmark). Takes precedence over `logo`. */
  logoElement?: ReactNode;
  /** Image source for the logo (e.g. require('./logo.png')) */
  logo?: ImageSourcePropType;
  /** Logo dimensions override (default: { width: 40, height: 40 } inside the brand tile) */
  logoSize?: { width: number; height: number };
  /** App name displayed as text when no logo is provided */
  appName: string;
  /** Subtitle text below the title */
  subtitle?: string;
  /** Optional translated copy. Defaults to English. */
  copy?: Partial<LoginScreenCopy>;
  /** Show email/password login form (default: true) */
  showEmailLogin?: boolean;
  /** Show Google OAuth button (default: true) */
  showGoogleLogin?: boolean;
  /** Show Apple OAuth button on iOS (default: true) */
  showAppleLogin?: boolean;
  /** Brand accent for CTA, focus rings, and links (default: '#3B82F6') */
  accentColor?: string;
}

type AuthMode = 'signin' | 'forgot' | 'reset';

function validateNewPassword(pwd: string): boolean {
  return pwd.length >= 8 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd);
}

export function LoginScreen({
  logoElement,
  logo,
  logoSize,
  appName,
  subtitle,
  copy,
  showEmailLogin = true,
  showGoogleLogin = true,
  showAppleLogin = true,
  accentColor = '#3B82F6',
}: LoginScreenProps) {
  useWarmUpBrowser();
  const { colors } = useTheme();
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const { userMemberships, setActive: setOrgActive, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const toast = useToast();
  const labels: LoginScreenCopy = {
    ...DEFAULT_COPY,
    ...copy,
    subtitle: copy?.subtitle ?? subtitle ?? DEFAULT_COPY.subtitle,
  };

  const isAppleDevice = Platform.OS === 'ios';
  const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android';

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAppleLoading, setIsAppleLoading] = useState(false);

  // Reset-password fields
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  type MfaStrategy = 'totp' | 'phone_code' | 'backup_code';
  interface MfaState {
    strategy: MfaStrategy;
    phoneNumberId?: string;
    safeIdentifier?: string;
    supported: MfaStrategy[];
  }
  const [mfa, setMfa] = useState<MfaState | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);

  const autoSelectOrg = useCallback(async () => {
    if (isOrgListLoaded && userMemberships?.data?.length) {
      await setOrgActive({ organization: userMemberships.data[0].organization.id });
    }
  }, [isOrgListLoaded, userMemberships, setOrgActive]);

  const enterMfa = async (signIn: any): Promise<void> => {
    const factors = (signIn.supportedSecondFactors || []) as Array<any>;
    const supported: MfaStrategy[] = factors
      .map((f) => f.strategy as MfaStrategy)
      .filter((s) => s === 'totp' || s === 'phone_code' || s === 'backup_code');

    const preferred: MfaStrategy =
      supported.find((s) => s === 'totp') ||
      supported.find((s) => s === 'phone_code') ||
      supported[0] ||
      'totp';

    let phoneFactor: any = null;
    if (preferred === 'phone_code') {
      phoneFactor = factors.find((f) => f.strategy === 'phone_code');
      try {
        await signIn.prepareSecondFactor({
          strategy: 'phone_code',
          phoneNumberId: phoneFactor?.phoneNumberId,
        });
      } catch (err: any) {
        console.error('prepareSecondFactor failed:', err);
        setFormError(err?.errors?.[0]?.message || labels.sendCodeFailed);
        return;
      }
    }

    setMfa({
      strategy: preferred,
      phoneNumberId: phoneFactor?.phoneNumberId,
      safeIdentifier: phoneFactor?.safeIdentifier,
      supported,
    });
    setMfaCode('');
    setFormError(null);
  };

  const backToSignIn = () => {
    setMode('signin');
    setMfa(null);
    setMfaCode('');
    setFormError(null);
    setResetCode('');
    setNewPassword('');
    setConfirmPassword('');
    setPassword('');
    setShowPassword(false);
    setShowNewPassword(false);
  };

  const openForgot = () => {
    setMode('forgot');
    setFormError(null);
    setPassword('');
    setMfa(null);
  };

  const onSignIn = async () => {
    if (!email.trim()) {
      setFormError(labels.enterEmail);
      return;
    }
    if (!password) {
      setFormError(labels.enterPassword);
      return;
    }

    setFormError(null);
    setIsValidating(true);

    try {
      const result = await clerk.client.signIn.create({
        identifier: email.trim(),
        password: password,
      });

      if (result.status === 'complete') {
        await clerk.setActive({ session: result.createdSessionId });
        await autoSelectOrg();
      } else if (result.status === 'needs_second_factor') {
        await enterMfa(result);
      } else {
        setFormError(`Additional verification required (${result.status})`);
      }
    } catch (e: any) {
      console.error('Sign in error:', e);
      const errorMessage = e.errors?.[0]?.message || e.message || labels.invalidCredentials;
      setFormError(errorMessage);
      toast.error(labels.loginFailed);
    } finally {
      setIsValidating(false);
    }
  };

  const onSendResetCode = async () => {
    if (!email.trim()) {
      setFormError(labels.enterEmail);
      return;
    }

    setFormError(null);
    setIsSendingReset(true);

    try {
      await clerk.client.signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email.trim(),
      });
    } catch {
      // Always proceed to avoid email enumeration (same as web)
    } finally {
      setIsSendingReset(false);
      setResetCode('');
      setNewPassword('');
      setConfirmPassword('');
      setMode('reset');
    }
  };

  const onResetPassword = async () => {
    const code = resetCode.trim();
    if (!code) {
      setFormError(labels.enterCode);
      return;
    }
    if (!validateNewPassword(newPassword)) {
      setFormError(labels.passwordRequirements);
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError(labels.passwordsDoNotMatch);
      return;
    }

    setFormError(null);
    setIsResetting(true);

    try {
      const result = await clerk.client.signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code,
        password: newPassword,
      });

      if (result.status === 'complete') {
        await clerk.setActive({ session: result.createdSessionId });
        await autoSelectOrg();
      } else if (result.status === 'needs_second_factor') {
        await enterMfa(result);
      } else {
        setFormError(labels.passwordResetFailed);
      }
    } catch (e: any) {
      console.error('Password reset error:', e);
      const errorMessage = e.errors?.[0]?.message || e.message || labels.invalidResetCode;
      setFormError(errorMessage);
    } finally {
      setIsResetting(false);
    }
  };

  const onVerifyMfa = async () => {
    if (!mfa) return;
    const code = mfaCode.trim();
    if (!code) {
      setFormError(labels.enterCode);
      return;
    }

    setFormError(null);
    setIsVerifyingMfa(true);

    try {
      const result = await clerk.client.signIn.attemptSecondFactor({
        strategy: mfa.strategy,
        code,
      } as any);

      if (result.status === 'complete') {
        await clerk.setActive({ session: result.createdSessionId });
        await autoSelectOrg();
      } else {
        setFormError(`Verification incomplete (${result.status})`);
      }
    } catch (e: any) {
      console.error('MFA verification error:', e);
      const errorMessage = e.errors?.[0]?.message || e.message || labels.invalidCode;
      setFormError(errorMessage);
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const switchMfaStrategy = async (next: MfaStrategy) => {
    if (!mfa || next === mfa.strategy) return;
    setFormError(null);
    setMfaCode('');

    if (next === 'phone_code') {
      setIsVerifyingMfa(true);
      try {
        await clerk.client.signIn.prepareSecondFactor({
          strategy: 'phone_code',
          phoneNumberId: mfa.phoneNumberId,
        } as any);
      } catch (err: any) {
        console.error('prepareSecondFactor failed:', err);
        setFormError(err?.errors?.[0]?.message || labels.sendCodeFailed);
        setIsVerifyingMfa(false);
        return;
      }
      setIsVerifyingMfa(false);
    }

    setMfa({ ...mfa, strategy: next });
  };

  const cancelMfa = () => {
    // After reset MFA cancel, return to reset form; otherwise sign-in
    setMfa(null);
    setMfaCode('');
    setFormError(null);
    if (mode === 'reset') {
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setPassword('');
      setMode('signin');
    }
  };

  if (isSignedIn) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={accentColor} />
          <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const anyLoading = isValidating || isGoogleLoading || isAppleLoading || isSendingReset || isResetting;
  const iconW = logoSize?.width ?? 40;
  const iconH = logoSize?.height ?? 40;

  const pageTitle = mfa
    ? labels.twoStepTitle
    : mode === 'forgot'
      ? labels.forgotTitle
      : mode === 'reset'
        ? labels.resetTitle
        : labels.signInTitle;

  const pageSubtitle = mfa
    ? mfa.strategy === 'totp'
      ? labels.totpHint
      : mfa.strategy === 'phone_code'
        ? labels.phoneHint.replace('{phone}', mfa.safeIdentifier || labels.phoneFallback)
        : labels.backupHint
    : mode === 'forgot'
      ? labels.forgotSubtitle
      : mode === 'reset'
        ? labels.resetSubtitle
        : labels.subtitle;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.content}>
            {logoElement ? (
              <View style={styles.logoElement}>{logoElement}</View>
            ) : logo ? (
              <View style={[styles.brandTile, { backgroundColor: tint(accentColor, colors.secondary) }]}>
                <Image
                  source={logo}
                  style={{ width: iconW, height: iconH }}
                  resizeMode="contain"
                />
              </View>
            ) : (
              <Text style={[styles.appNameTitle, { color: colors.text }]}>
                {appName}
              </Text>
            )}

            <View style={styles.welcomeSection}>
              <Text style={[styles.pageTitle, { color: colors.text }]}>{pageTitle}</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{pageSubtitle}</Text>
            </View>

            {/* MFA Form */}
            {mfa && (
              <View style={styles.formContainer}>
                <View style={styles.inputContainer}>
                  <LoginField
                    accentColor={accentColor}
                    colors={colors}
                    value={mfaCode}
                    onChangeText={(text) => {
                      setMfaCode(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={mfa.strategy === 'backup_code' ? labels.backupCodePlaceholder : labels.verificationCodePlaceholder}
                    keyboardType={mfa.strategy === 'backup_code' ? 'default' : 'number-pad'}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete={mfa.strategy === 'totp' ? 'one-time-code' : 'off'}
                    textContentType={mfa.strategy !== 'backup_code' ? 'oneTimeCode' : undefined}
                    autoFocus
                    editable={!isVerifyingMfa}
                  />
                </View>

                {formError && (
                  <View style={[styles.formErrorContainer, { backgroundColor: `${colors.destructive}1A` }]}>
                    <Text style={[styles.formErrorText, { color: colors.destructive }]}>{formError}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: accentColor },
                    isVerifyingMfa && styles.buttonDisabled,
                  ]}
                  onPress={onVerifyMfa}
                  activeOpacity={0.8}
                  disabled={isVerifyingMfa}
                >
                  {isVerifyingMfa ? (
                    <ActivityIndicator color={ACCENT_FOREGROUND} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: ACCENT_FOREGROUND }]}>
                      {labels.verify}
                    </Text>
                  )}
                </TouchableOpacity>

                <View style={styles.mfaSwitcher}>
                  {mfa.supported.filter((s) => s !== mfa.strategy).map((s) => (
                    <TouchableOpacity
                      key={s}
                      onPress={() => switchMfaStrategy(s)}
                      disabled={isVerifyingMfa}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.mfaSwitchText, { color: accentColor }]}>
                        {s === 'totp' && labels.useAuthenticator}
                        {s === 'phone_code' && labels.sendSms}
                        {s === 'backup_code' && labels.useBackup}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={cancelMfa} disabled={isVerifyingMfa} activeOpacity={0.7}>
                    <Text style={[styles.mfaSwitchText, { color: colors.mutedForeground }]}>
                      {labels.backToSignIn}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Forgot password — request code */}
            {!mfa && mode === 'forgot' && (
              <View style={styles.formContainer}>
                <View style={styles.inputContainer}>
                  <LoginField
                    accentColor={accentColor}
                    colors={colors}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={labels.emailPlaceholder}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    autoFocus
                    editable={!isSendingReset}
                  />
                </View>

                {formError && (
                  <View style={[styles.formErrorContainer, { backgroundColor: `${colors.destructive}1A` }]}>
                    <Text style={[styles.formErrorText, { color: colors.destructive }]}>{formError}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: accentColor },
                    isSendingReset && styles.buttonDisabled,
                  ]}
                  onPress={onSendResetCode}
                  activeOpacity={0.8}
                  disabled={isSendingReset}
                >
                  {isSendingReset ? (
                    <ActivityIndicator color={ACCENT_FOREGROUND} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: ACCENT_FOREGROUND }]}>
                      {labels.sendResetCode}
                    </Text>
                  )}
                </TouchableOpacity>

                <View style={styles.mfaSwitcher}>
                  <TouchableOpacity onPress={backToSignIn} disabled={isSendingReset} activeOpacity={0.7}>
                    <Text style={[styles.mfaSwitchText, { color: colors.mutedForeground }]}>
                      {labels.backToSignIn}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Reset password — code + new password */}
            {!mfa && mode === 'reset' && (
              <View style={styles.formContainer}>
                <View style={styles.inputContainer}>
                  <LoginField
                    accentColor={accentColor}
                    colors={colors}
                    value={resetCode}
                    onChangeText={(text) => {
                      setResetCode(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={labels.resetCodePlaceholder}
                    keyboardType="number-pad"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    autoFocus
                    editable={!isResetting}
                  />
                </View>

                <View style={styles.inputContainer}>
                  <LoginField
                    accentColor={accentColor}
                    colors={colors}
                    value={newPassword}
                    onChangeText={(text) => {
                      setNewPassword(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={labels.newPasswordPlaceholder}
                    secureTextEntry={!showNewPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    editable={!isResetting}
                    rightElement={
                      <PasswordToggle
                        show={showNewPassword}
                        onToggle={() => setShowNewPassword((v) => !v)}
                        hideLabel={labels.hidePassword}
                        showLabel={labels.showPassword}
                        color={colors.mutedForeground}
                      />
                    }
                  />
                </View>

                <View style={styles.inputContainer}>
                  <LoginField
                    accentColor={accentColor}
                    colors={colors}
                    value={confirmPassword}
                    onChangeText={(text) => {
                      setConfirmPassword(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={labels.confirmPasswordPlaceholder}
                    secureTextEntry={!showNewPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    editable={!isResetting}
                  />
                </View>

                {formError && (
                  <View style={[styles.formErrorContainer, { backgroundColor: `${colors.destructive}1A` }]}>
                    <Text style={[styles.formErrorText, { color: colors.destructive }]}>{formError}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: accentColor },
                    isResetting && styles.buttonDisabled,
                  ]}
                  onPress={onResetPassword}
                  activeOpacity={0.8}
                  disabled={isResetting}
                >
                  {isResetting ? (
                    <ActivityIndicator color={ACCENT_FOREGROUND} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: ACCENT_FOREGROUND }]}>
                      {labels.resetPassword}
                    </Text>
                  )}
                </TouchableOpacity>

                <View style={styles.mfaSwitcher}>
                  <TouchableOpacity
                    onPress={() => {
                      setFormError(null);
                      setMode('forgot');
                    }}
                    disabled={isResetting}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.mfaSwitchText, { color: accentColor }]}>
                      {labels.sendResetCode}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={backToSignIn} disabled={isResetting} activeOpacity={0.7}>
                    <Text style={[styles.mfaSwitchText, { color: colors.mutedForeground }]}>
                      {labels.backToSignIn}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Sign-in form */}
            {!mfa && mode === 'signin' && (
            <View style={styles.formContainer}>
              {showEmailLogin && (
                <>
                  <View style={styles.inputContainer}>
                    <LoginField
                      accentColor={accentColor}
                      colors={colors}
                      value={email}
                      onChangeText={(text) => {
                        setEmail(text);
                        if (formError) setFormError(null);
                      }}
                      placeholder={labels.emailPlaceholder}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      editable={!isValidating}
                    />
                  </View>

                  <View style={styles.inputContainer}>
                    <LoginField
                      accentColor={accentColor}
                      colors={colors}
                      value={password}
                      onChangeText={(text) => {
                        setPassword(text);
                        if (formError) setFormError(null);
                      }}
                      placeholder={labels.passwordPlaceholder}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="password"
                      editable={!isValidating}
                      rightElement={
                        <PasswordToggle
                          show={showPassword}
                          onToggle={() => setShowPassword((v) => !v)}
                          hideLabel={labels.hidePassword}
                          showLabel={labels.showPassword}
                          color={colors.mutedForeground}
                        />
                      }
                    />
                  </View>

                  <TouchableOpacity style={styles.forgotPassword} onPress={openForgot} activeOpacity={0.7}>
                    <Text style={[styles.forgotPasswordText, { color: accentColor }]}>
                      {labels.forgotPassword}
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {formError && (
                <View style={[styles.formErrorContainer, { backgroundColor: `${colors.destructive}1A` }]}>
                  <Text style={[styles.formErrorText, { color: colors.destructive }]}>
                    {formError}
                  </Text>
                </View>
              )}

              {showEmailLogin && (
                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: accentColor },
                    isValidating && styles.buttonDisabled,
                  ]}
                  onPress={onSignIn}
                  activeOpacity={0.8}
                  disabled={isValidating}
                >
                  {isValidating ? (
                    <ActivityIndicator color={ACCENT_FOREGROUND} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: ACCENT_FOREGROUND }]}>
                      {labels.signIn}
                    </Text>
                  )}
                </TouchableOpacity>
              )}

              {showEmailLogin && ((showGoogleLogin && isNativePlatform) || (showAppleLogin && isAppleDevice)) && (
                <View style={styles.dividerContainer}>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>{labels.or}</Text>
                  <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
                </View>
              )}

              {showGoogleLogin && isNativePlatform && (
                <OAuthErrorBoundary>
                  <GoogleSignInButton
                    onOrgSelect={autoSelectOrg}
                    disabled={anyLoading}
                    isLoading={isGoogleLoading}
                    setIsLoading={setIsGoogleLoading}
                    setFormError={setFormError}
                    noAccount={labels.noAccount}
                    googleFailed={labels.googleFailed}
                    continueGoogle={labels.continueGoogle}
                    colors={colors}
                  />
                </OAuthErrorBoundary>
              )}

              {showAppleLogin && isAppleDevice && (
                <OAuthErrorBoundary>
                  <AppleSignInButton
                    onOrgSelect={autoSelectOrg}
                    disabled={anyLoading}
                    isLoading={isAppleLoading}
                    setIsLoading={setIsAppleLoading}
                    setFormError={setFormError}
                    noAccount={labels.noAccount}
                    appleFailed={labels.appleFailed}
                    continueApple={labels.continueApple}
                    colors={colors}
                  />
                </OAuthErrorBoundary>
              )}
            </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardAvoid: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  content: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  brandTile: {
    width: 72,
    height: 72,
    borderRadius: Radii.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  logoElement: {
    marginBottom: Spacing.xl,
    alignSelf: 'flex-start',
  },
  appNameTitle: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.4,
    lineHeight: 32,
    marginBottom: Spacing.xl,
  },
  welcomeSection: {
    marginBottom: 28,
  },
  pageTitle: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -0.4,
    lineHeight: 32,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  formContainer: {
    width: '100%',
  },
  inputContainer: {
    width: '100%',
    marginBottom: Spacing.md,
  },
  field: {
    width: '100%',
    height: 52,
    borderRadius: Radii.lg,
    borderWidth: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  fieldInput: {
    flex: 1,
    height: '100%',
    paddingHorizontal: Spacing.lg,
    fontSize: 16,
  },
  fieldInputWithIcon: {
    paddingRight: 48,
  },
  passwordToggle: {
    position: 'absolute',
    right: 0,
    top: 0,
    height: 52,
    width: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  formErrorContainer: {
    width: '100%',
    marginBottom: Spacing.lg,
    padding: Spacing.md,
    borderRadius: Radii.md,
  },
  formErrorText: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  signInButton: {
    width: '100%',
    height: 52,
    borderRadius: Radii.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  signInButtonText: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  loadingText: {
    marginTop: Spacing.lg,
    fontSize: 15,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: Spacing.xl,
    marginTop: -Spacing.xs,
  },
  forgotPasswordText: {
    fontSize: 14,
    fontWeight: '600',
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: Spacing.xl,
    gap: Spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: 13,
    fontWeight: '500',
  },
  oauthButton: {
    width: '100%',
    height: 52,
    borderRadius: Radii.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  oauthButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  oauthIcon: {
    width: 20,
    height: 20,
  },
  oauthButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  appleIcon: {
    fontSize: 18,
  },
  mfaSwitcher: {
    marginTop: Spacing.xl,
    gap: Spacing.md,
    alignItems: 'flex-start',
  },
  mfaSwitchText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
