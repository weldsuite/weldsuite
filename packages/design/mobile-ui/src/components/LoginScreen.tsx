import React, { useState, useCallback, Component, type ReactNode, type ErrorInfo } from 'react';
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
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { useClerk, useAuth, useSSO, useOrganizationList } from '@clerk/expo';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { Eye, EyeOff } from 'lucide-react-native';

WebBrowser.maybeCompleteAuthSession();
import { Colors } from '../constants/theme';
import { useToast } from '../contexts/ToastContext';

// Always use light theme for login screen
const theme = Colors.light;

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

// Google button — uses useSSO (Clerk managed OAuth redirect, no client ID needed)
function GoogleSignInButton({
  onOrgSelect,
  disabled,
  isLoading,
  setIsLoading,
  setFormError,
}: {
  onOrgSelect: () => Promise<void>;
  disabled: boolean;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
  setFormError: (v: string | null) => void;
}) {
  const { startSSOFlow } = useSSO();
  const toast = useToast();

  const onPress = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    setFormError(null);
    try {
      const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
      const { createdSessionId, setActive } = await startSSOFlow({ strategy: 'oauth_google', redirectUrl });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        await onOrgSelect();
      } else {
        setFormError('No account found. Please create an account at app.weldsuite.org first.');
      }
    } catch (e: any) {
      if (e.code === 'SIGN_IN_CANCELLED' || e.code === '-5' || e.code === 'ERR_REQUEST_CANCELED') return;
      const isNoAccount = e.errors?.some((err: any) =>
        err.code === 'external_account_not_found' || err.code === 'identifier_not_found'
      );
      if (isNoAccount) {
        setFormError('No account found. Please create an account at app.weldsuite.org first.');
      } else {
        console.error('Google sign in error:', JSON.stringify(e, null, 2));
        const errorMessage = e.errors?.[0]?.message || e.message || 'Google sign in failed';
        setFormError(errorMessage);
        toast.error('Google sign in failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [startSSOFlow, isLoading, toast, onOrgSelect, setIsLoading, setFormError]);

  return (
    <TouchableOpacity
      style={[
        styles.oauthButton,
        { borderColor: theme.buttonBorder },
        isLoading && styles.buttonDisabled,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled || isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color={theme.text} />
      ) : (
        <View style={styles.oauthButtonContent}>
          <Image
            source={{ uri: 'https://developers.google.com/identity/images/g-logo.png' }}
            style={styles.oauthIcon}
          />
          <Text style={[styles.oauthButtonText, { color: theme.text }]}>
            Continue with Google
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
}: {
  onOrgSelect: () => Promise<void>;
  disabled: boolean;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
  setFormError: (v: string | null) => void;
}) {
  const { startSSOFlow } = useSSO();
  const toast = useToast();

  const onPress = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    setFormError(null);
    try {
      const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
      const { createdSessionId, setActive } = await startSSOFlow({ strategy: 'oauth_apple', redirectUrl });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        await onOrgSelect();
      } else {
        setFormError('No account found. Please create an account at app.weldsuite.org first.');
      }
    } catch (e: any) {
      if (e.code === 'ERR_REQUEST_CANCELED') return;
      const isNoAccount = e.errors?.some((err: any) =>
        err.code === 'external_account_not_found' || err.code === 'identifier_not_found'
      );
      if (isNoAccount) {
        setFormError('No account found. Please create an account at app.weldsuite.org first.');
      } else {
        console.error('Apple sign in error:', JSON.stringify(e, null, 2));
        const errorMessage = e.errors?.[0]?.message || e.message || 'Apple sign in failed';
        setFormError(errorMessage);
        toast.error('Apple sign in failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [startSSOFlow, isLoading, toast, onOrgSelect, setIsLoading, setFormError]);

  return (
    <TouchableOpacity
      style={[
        styles.appleButton,
        isLoading && styles.buttonDisabled,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled || isLoading}
    >
      {isLoading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <View style={styles.oauthButtonContent}>
          <Text style={styles.appleIcon}>{'\uF8FF'}</Text>
          <Text style={styles.appleButtonText}>
            Continue with Apple
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export interface LoginScreenProps {
  /** Custom logo element (e.g. an SVG wordmark). Takes precedence over `logo`. */
  logoElement?: ReactNode;
  /** Image source for the logo (e.g. require('./logo.png')) */
  logo?: ImageSourcePropType;
  /** Logo dimensions override (default: { width: 160, height: 45 }) */
  logoSize?: { width: number; height: number };
  /** App name displayed as text when no logo is provided */
  appName: string;
  /** Subtitle text below the title */
  subtitle?: string;
  /** Show email/password login form (default: true) */
  showEmailLogin?: boolean;
  /** Show Google OAuth button (default: true) */
  showGoogleLogin?: boolean;
  /** Show Apple OAuth button on iOS (default: true) */
  showAppleLogin?: boolean;
  /** Accent color for the Google button (default: '#3B82F6') */
  accentColor?: string;
}

export function LoginScreen({
  logoElement,
  logo,
  logoSize,
  appName,
  subtitle = 'Enter your credentials to access your workspace',
  showEmailLogin = true,
  showGoogleLogin = true,
  showAppleLogin = true,
  accentColor = '#3B82F6',
}: LoginScreenProps) {
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const { userMemberships, setActive: setOrgActive, isLoaded: isOrgListLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const toast = useToast();

  const isAppleDevice = Platform.OS === 'ios';
  const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isAppleLoading, setIsAppleLoading] = useState(false);

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

    // Prefer TOTP, then SMS, then backup code
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
        setFormError(err?.errors?.[0]?.message || 'Failed to send verification code');
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

  const onSignIn = async () => {
    if (!email.trim()) {
      setFormError('Please enter your email');
      return;
    }
    if (!password) {
      setFormError('Please enter your password');
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
      const errorMessage = e.errors?.[0]?.message || e.message || 'Invalid email or password';
      setFormError(errorMessage);
      toast.error('Login failed');
    } finally {
      setIsValidating(false);
    }
  };

  const onVerifyMfa = async () => {
    if (!mfa) return;
    const code = mfaCode.trim();
    if (!code) {
      setFormError('Please enter the verification code');
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
      const errorMessage = e.errors?.[0]?.message || e.message || 'Invalid verification code';
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
        setFormError(err?.errors?.[0]?.message || 'Failed to send verification code');
        setIsVerifyingMfa(false);
        return;
      }
      setIsVerifyingMfa(false);
    }

    setMfa({ ...mfa, strategy: next });
  };

  const cancelMfa = () => {
    setMfa(null);
    setMfaCode('');
    setFormError(null);
    setPassword('');
  };

  // Show loading only while user is being redirected after sign-in
  if (isSignedIn) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.tint} />
        <Text style={[styles.loadingText, { color: theme.text }]}>Loading...</Text>
      </View>
    );
  }

  const anyLoading = isValidating || isGoogleLoading || isAppleLoading;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
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
            {/* Logo or App Name */}
            {logoElement ? (
              <View style={styles.logoElement}>{logoElement}</View>
            ) : logo ? (
              <Image
                source={logo}
                style={[styles.logo, logoSize && { width: logoSize.width, height: logoSize.height }]}
                resizeMode="contain"
              />
            ) : (
              <Text style={[styles.appNameTitle, { color: theme.text }]}>
                {appName}
              </Text>
            )}

            {/* Welcome Section */}
            <View style={styles.welcomeSection}>
              <Text style={[styles.pageTitle, { color: theme.text }]}>
                {mfa ? 'Two-step verification' : 'Sign in to your account'}
              </Text>
              <Text style={[styles.subtitle, { color: theme.muted }]}>
                {mfa
                  ? mfa.strategy === 'totp'
                    ? 'Enter the 6-digit code from your authenticator app.'
                    : mfa.strategy === 'phone_code'
                      ? `Enter the code we sent to ${mfa.safeIdentifier || 'your phone'}.`
                      : 'Enter one of your backup codes.'
                  : subtitle}
              </Text>
            </View>

            {/* MFA Form */}
            {mfa && (
              <View style={styles.formContainer}>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={[styles.input, {
                      backgroundColor: theme.background,
                      borderColor: theme.buttonBorder,
                      color: theme.text,
                    }]}
                    value={mfaCode}
                    onChangeText={(text) => {
                      setMfaCode(text);
                      if (formError) setFormError(null);
                    }}
                    placeholder={mfa.strategy === 'backup_code' ? 'Backup code' : 'Verification code'}
                    placeholderTextColor={theme.muted}
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
                  <View style={styles.formErrorContainer}>
                    <Text style={styles.formErrorText}>{formError}</Text>
                  </View>
                )}

                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: theme.tint },
                    isVerifyingMfa && styles.buttonDisabled,
                  ]}
                  onPress={onVerifyMfa}
                  activeOpacity={0.8}
                  disabled={isVerifyingMfa}
                >
                  {isVerifyingMfa ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: theme.background }]}>
                      Verify
                    </Text>
                  )}
                </TouchableOpacity>

                {/* Strategy switchers */}
                <View style={styles.mfaSwitcher}>
                  {mfa.supported.filter((s) => s !== mfa.strategy).map((s) => (
                    <TouchableOpacity
                      key={s}
                      onPress={() => switchMfaStrategy(s)}
                      disabled={isVerifyingMfa}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.mfaSwitchText, { color: theme.tint }]}>
                        {s === 'totp' && 'Use authenticator app'}
                        {s === 'phone_code' && 'Send code via SMS'}
                        {s === 'backup_code' && 'Use a backup code'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={cancelMfa} disabled={isVerifyingMfa} activeOpacity={0.7}>
                    <Text style={[styles.mfaSwitchText, { color: theme.muted }]}>Back to sign in</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Login Form */}
            {!mfa && (
            <View style={styles.formContainer}>
              {showEmailLogin && (
                <>
                  {/* Email Input */}
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={[styles.input, {
                        backgroundColor: theme.background,
                        borderColor: theme.buttonBorder,
                        color: theme.text,
                      }]}
                      value={email}
                      onChangeText={(text) => {
                        setEmail(text);
                        if (formError) setFormError(null);
                      }}
                      placeholder="Email address"
                      placeholderTextColor={theme.muted}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                      editable={!isValidating}
                    />
                  </View>

                  {/* Password Input */}
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={[styles.input, styles.inputWithIcon, {
                        backgroundColor: theme.background,
                        borderColor: theme.buttonBorder,
                        color: theme.text,
                      }]}
                      value={password}
                      onChangeText={(text) => {
                        setPassword(text);
                        if (formError) setFormError(null);
                      }}
                      placeholder="Password"
                      placeholderTextColor={theme.muted}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="password"
                      editable={!isValidating}
                    />
                    <TouchableOpacity
                      style={styles.passwordToggle}
                      onPress={() => setShowPassword((v) => !v)}
                      activeOpacity={0.7}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <Eye size={18} color={theme.muted} />
                      ) : (
                        <EyeOff size={18} color={theme.muted} />
                      )}
                    </TouchableOpacity>
                  </View>

                  {/* Forgot Password */}
                  <TouchableOpacity style={styles.forgotPassword} activeOpacity={0.7}>
                    <Text style={[styles.forgotPasswordText, { color: theme.muted }]}>
                      Forgot password?
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {/* Form Error */}
              {formError && (
                <View style={styles.formErrorContainer}>
                  <Text style={styles.formErrorText}>
                    {formError}
                  </Text>
                </View>
              )}

              {/* Sign In Button (email/password) */}
              {showEmailLogin && (
                <TouchableOpacity
                  style={[
                    styles.signInButton,
                    { backgroundColor: theme.tint },
                    isValidating && styles.buttonDisabled,
                  ]}
                  onPress={onSignIn}
                  activeOpacity={0.8}
                  disabled={isValidating}
                >
                  {isValidating ? (
                    <ActivityIndicator color={theme.background} />
                  ) : (
                    <Text style={[styles.signInButtonText, { color: theme.background }]}>
                      Sign In
                    </Text>
                  )}
                </TouchableOpacity>
              )}

              {/* Divider (only when social login methods are shown) */}
              {showEmailLogin && ((showGoogleLogin && isNativePlatform) || (showAppleLogin && isAppleDevice)) && (
                <View style={styles.dividerContainer}>
                  <View style={[styles.dividerLine, { backgroundColor: theme.buttonBorder }]} />
                  <Text style={[styles.dividerText, { color: theme.muted }]}>or</Text>
                  <View style={[styles.dividerLine, { backgroundColor: theme.buttonBorder }]} />
                </View>
              )}

              {/* Google Sign In Button (native only) — isolated so missing credentials don't break the form */}
              {showGoogleLogin && isNativePlatform && (
                <OAuthErrorBoundary>
                  <GoogleSignInButton
                    onOrgSelect={autoSelectOrg}
                    disabled={anyLoading}
                    isLoading={isGoogleLoading}
                    setIsLoading={setIsGoogleLoading}
                    setFormError={setFormError}
                  />
                </OAuthErrorBoundary>
              )}

              {/* Apple Sign In Button (iOS only) — isolated so missing credentials don't break the form */}
              {showAppleLogin && isAppleDevice && (
                <OAuthErrorBoundary>
                  <AppleSignInButton
                    onOrgSelect={autoSelectOrg}
                    disabled={anyLoading}
                    isLoading={isAppleLoading}
                    setIsLoading={setIsAppleLoading}
                    setFormError={setFormError}
                  />
                </OAuthErrorBoundary>
              )}
            </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
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
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
  },
  logo: {
    width: 160,
    height: 45,
    marginBottom: 30,
  },
  logoElement: {
    marginBottom: 30,
  },
  appNameTitle: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 30,
  },
  welcomeSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  formContainer: {
    width: '100%',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 14,
  },
  input: {
    width: '100%',
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  inputWithIcon: {
    paddingRight: 48,
  },
  passwordToggle: {
    position: 'absolute',
    right: 0,
    top: 0,
    height: 44,
    width: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  formErrorContainer: {
    width: '100%',
    marginBottom: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#FEE2E2',
  },
  formErrorText: {
    color: '#DC2626',
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '500',
  },
  signInButton: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  signInButtonText: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: 28,
    marginTop: -6,
  },
  forgotPasswordText: {
    fontSize: 13,
    fontWeight: '400',
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 14,
    fontWeight: '500',
  },
  oauthButton: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    backgroundColor: '#fff',
    marginBottom: 10,
  },
  oauthButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  oauthIcon: {
    width: 20,
    height: 20,
  },
  oauthButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  appleButton: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    marginBottom: 10,
  },
  appleIcon: {
    fontSize: 18,
    color: '#fff',
  },
  appleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  mfaSwitcher: {
    marginTop: 20,
    gap: 12,
    alignItems: 'center',
  },
  mfaSwitchText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
