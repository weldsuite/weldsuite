'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
  User as FirebaseUser,
  signInWithPopup,
  GoogleAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  TwitterAuthProvider,
  OAuthProvider
} from 'firebase/auth';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize Firebase only if it hasn't been initialized
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const clientAuth = getAuth(app);

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  emailVerified: boolean;
  roles: string[];
  workspaceId?: string;
  firebaseUser?: FirebaseUser;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  csrfToken: string | null;
  signIn: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<void>;
  socialSignIn: (provider: 'google' | 'facebook' | 'github' | 'twitter' | 'apple') => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  checkSession: () => Promise<boolean>;
  generateFingerprint: () => string;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Generate browser fingerprint
function generateBrowserFingerprint(): string {
  if (typeof window === 'undefined') return '';
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('fingerprint', 2, 2);
  }
  
  const fingerprint = {
    userAgent: navigator.userAgent,
    language: navigator.language,
    colorDepth: screen.colorDepth,
    deviceMemory: (navigator as any).deviceMemory || 0,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    screenResolution: `${screen.width}x${screen.height}`,
    availableScreenResolution: `${screen.availWidth}x${screen.availHeight}`,
    timezoneOffset: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionStorage: !!window.sessionStorage,
    localStorage: !!window.localStorage,
    indexedDb: !!window.indexedDB,
    addBehavior: !!(document.body as any).addBehavior,
    openDatabase: !!(window as any).openDatabase,
    cpuClass: (navigator as any).cpuClass || '',
    platform: navigator.platform,
    plugins: Array.from(navigator.plugins || []).map(p => p.name).join(','),
    canvas: canvas.toDataURL(),
    webgl: (() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl && 'getParameter' in gl) {
          return (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).VERSION);
        }
      } catch (e) {}
      return null;
    })(),
  };
  
  // Create hash from fingerprint data
  const fingerprintString = JSON.stringify(fingerprint);
  let hash = 0;
  for (let i = 0; i < fingerprintString.length; i++) {
    const char = fingerprintString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return Math.abs(hash).toString(36);
}

// Get CSRF token from cookie
function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  
  const match = document.cookie.match(/csrf-token=([^;]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

export function SecureAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Public paths that don't require authentication
  const publicPaths = ['/login', '/signup', '/reset-password', '/verify-email', '/'];

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Generate fingerprint
  const generateFingerprint = useCallback(() => {
    return generateBrowserFingerprint();
  }, []);

  // Check session validity
  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/api/v2/auth/session', {
        method: 'GET',
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        return data.success;
      }
      return false;
    } catch (error) {
      console.error('Session check failed:', error);
      return false;
    }
  }, []);

  // Refresh session
  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch('/api/v2/auth/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        credentials: 'include',
      });

      if (response.ok) {
        // Update CSRF token if provided
        const newCsrfToken = getCsrfToken();
        if (newCsrfToken) {
          setCsrfToken(newCsrfToken);
        }
      }
    } catch (error) {
      console.error('Session refresh failed:', error);
    }
  }, [csrfToken]);

  // Sign in
  const signIn = useCallback(async (email: string, password: string, rememberMe = false) => {
    try {
      setError(null);
      setLoading(true);

      // First authenticate with Firebase
      const userCredential = await signInWithEmailAndPassword(clientAuth, email, password);
      const idToken = await userCredential.user.getIdToken();

      // Then authenticate with our backend
      const response = await fetch('/api/v2/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          rememberMe,
          fingerprint: generateFingerprint(),
          idToken, // Send Firebase token for verification
        }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      // Update CSRF token
      const newCsrfToken = getCsrfToken();
      if (newCsrfToken) {
        setCsrfToken(newCsrfToken);
      }

      // Set user data
      setUser({
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        avatar: data.user.avatar,
        emailVerified: data.user.emailVerified,
        roles: data.user.roles || ['USER'],
        workspaceId: data.user.workspaceId,
        firebaseUser: userCredential.user,
      });

      // Redirect to dashboard or intended page within the same app
      const redirectParam = new URLSearchParams(window.location.search).get('redirect');
      let redirectTo = redirectParam || '/dashboard';
      
      // Ensure we stay within the same app - check if redirect is a relative path
      if (!redirectTo.startsWith('/')) {
        try {
          const redirectUrl = new URL(redirectTo);
          // If it's an absolute URL to a different origin, use default
          if (redirectUrl.origin !== window.location.origin) {
            redirectTo = '/dashboard';
          }
        } catch {
          // If URL parsing fails, use the redirect as-is (likely a relative path)
        }
      }
      
      router.push(redirectTo);
    } catch (error: any) {
      console.error('Sign in error:', error);
      setError(error.message || 'Failed to sign in');
      throw error;
    } finally {
      setLoading(false);
    }
  }, [router, generateFingerprint]);

  // Sign up
  const signUp = useCallback(async (email: string, password: string, name?: string) => {
    try {
      setError(null);
      setLoading(true);

      // Create Firebase account
      const userCredential = await createUserWithEmailAndPassword(clientAuth, email, password);
      const idToken = await userCredential.user.getIdToken();

      // Register with our backend
      const response = await fetch('/api/v2/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          confirmPassword: password,
          name,
          fingerprint: generateFingerprint(),
          acceptTerms: true,
          idToken,
        }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      // Update CSRF token
      const newCsrfToken = getCsrfToken();
      if (newCsrfToken) {
        setCsrfToken(newCsrfToken);
      }

      // Set user data
      setUser({
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        emailVerified: data.user.emailVerified,
        roles: ['USER'],
        firebaseUser: userCredential.user,
      });

      // Redirect to email verification or dashboard
      router.push(data.user.emailVerified ? '/dashboard' : '/verify-email');
    } catch (error: any) {
      console.error('Sign up error:', error);
      setError(error.message || 'Failed to create account');
      throw error;
    } finally {
      setLoading(false);
    }
  }, [router, generateFingerprint]);

  // Social sign in
  const socialSignIn = useCallback(async (provider: 'google' | 'facebook' | 'github' | 'twitter' | 'apple') => {
    try {
      setError(null);
      setLoading(true);

      let authProvider;
      switch (provider) {
        case 'google':
          authProvider = new GoogleAuthProvider();
          break;
        case 'facebook':
          authProvider = new FacebookAuthProvider();
          break;
        case 'github':
          authProvider = new GithubAuthProvider();
          break;
        case 'twitter':
          authProvider = new TwitterAuthProvider();
          break;
        case 'apple':
          authProvider = new OAuthProvider('apple.com');
          break;
        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }

      const userCredential = await signInWithPopup(clientAuth, authProvider);
      const idToken = await userCredential.user.getIdToken();

      // Authenticate with backend
      const response = await fetch(`/api/v2/auth/social/${provider}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idToken,
          fingerprint: generateFingerprint(),
        }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Social authentication failed');
      }

      // Update CSRF token
      const newCsrfToken = getCsrfToken();
      if (newCsrfToken) {
        setCsrfToken(newCsrfToken);
      }

      // Set user data
      setUser({
        id: data.user.id,
        email: data.user.email,
        name: data.user.name,
        avatar: data.user.avatar,
        emailVerified: data.user.emailVerified,
        roles: data.user.roles || ['USER'],
        workspaceId: data.user.workspaceId,
        firebaseUser: userCredential.user,
      });

      router.push('/dashboard');
    } catch (error: any) {
      console.error('Social sign in error:', error);
      setError(error.message || 'Social authentication failed');
      throw error;
    } finally {
      setLoading(false);
    }
  }, [router, generateFingerprint]);

  // Sign out
  const signOut = useCallback(async () => {
    try {
      setLoading(true);

      // Sign out from backend
      await fetch('/api/v2/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify({ logoutAll: false }),
        credentials: 'include',
      });

      // Sign out from Firebase
      await firebaseSignOut(clientAuth);

      // Clear user data
      setUser(null);
      setCsrfToken(null);

      // Redirect to login
      router.push('/login');
    } catch (error: any) {
      console.error('Sign out error:', error);
      setError(error.message || 'Failed to sign out');
    } finally {
      setLoading(false);
    }
  }, [router, csrfToken]);

  // Sign out from all devices
  const signOutAll = useCallback(async () => {
    try {
      setLoading(true);

      // Sign out from all sessions
      await fetch('/api/v2/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify({ logoutAll: true }),
        credentials: 'include',
      });

      // Sign out from Firebase
      await firebaseSignOut(clientAuth);

      // Clear user data
      setUser(null);
      setCsrfToken(null);

      // Redirect to login
      router.push('/login');
    } catch (error: any) {
      console.error('Sign out all error:', error);
      setError(error.message || 'Failed to sign out from all devices');
    } finally {
      setLoading(false);
    }
  }, [router, csrfToken]);

  // Reset password
  const resetPassword = useCallback(async (email: string) => {
    try {
      setError(null);
      await sendPasswordResetEmail(clientAuth, email);
    } catch (error: any) {
      console.error('Reset password error:', error);
      setError(error.message || 'Failed to send reset email');
      throw error;
    }
  }, []);

  // Monitor auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(clientAuth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Verify session with backend
          const isValid = await checkSession();
          
          if (isValid) {
            // Get user data from backend
            const response = await fetch('/api/v2/auth/me', {
              credentials: 'include',
            });

            if (response.ok) {
              const data = await response.json();
              setUser({
                id: data.user.id,
                email: data.user.email,
                name: data.user.name,
                avatar: data.user.avatar,
                emailVerified: data.user.emailVerified,
                roles: data.user.roles || ['USER'],
                workspaceId: data.user.workspaceId,
                firebaseUser,
              });

              // Update CSRF token
              const newCsrfToken = getCsrfToken();
              if (newCsrfToken) {
                setCsrfToken(newCsrfToken);
              }
            } else {
              setUser(null);
            }
          } else {
            // Session invalid, clear user
            setUser(null);
            await firebaseSignOut(clientAuth);
          }
        } catch (error) {
          console.error('Auth state check error:', error);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [checkSession]);

  // Auto-refresh session
  useEffect(() => {
    if (!user) return;

    // Refresh session every 14 minutes (before 15-minute rotation)
    const interval = setInterval(() => {
      refreshSession();
    }, 14 * 60 * 1000);

    return () => clearInterval(interval);
  }, [user, refreshSession]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!loading && !user && !publicPaths.includes(pathname)) {
      router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
  }, [loading, user, pathname, router, publicPaths]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        csrfToken,
        signIn,
        signUp,
        signOut,
        signOutAll,
        socialSignIn,
        resetPassword,
        refreshSession,
        checkSession,
        generateFingerprint,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}