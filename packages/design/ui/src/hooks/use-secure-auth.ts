import { useState, useEffect, useCallback } from 'react';
import { useAuth as useAuthContext } from '../providers/secure-auth-provider';

// Re-export useAuth for convenience
export { useAuth } from '../providers/secure-auth-provider';

// Hook for protected routes
export function useRequireAuth(redirectTo = '/login') {
  const { user, loading } = useAuthContext();
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = `${redirectTo}?redirect=${encodeURIComponent(window.location.pathname)}`;
    } else if (user) {
      setIsAuthorized(true);
    }
  }, [user, loading, redirectTo]);

  return { isAuthorized, loading };
}

// Hook for role-based access
export function useRequireRole(requiredRoles: string[], redirectTo = '/unauthorized') {
  const { user, loading } = useAuthContext();
  const [hasRole, setHasRole] = useState(false);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
      } else {
        const userHasRole = requiredRoles.some(role => user.roles.includes(role));
        if (userHasRole) {
          setHasRole(true);
        } else {
          window.location.href = redirectTo;
        }
      }
    }
  }, [user, loading, requiredRoles, redirectTo]);

  return { hasRole, loading };
}

// Hook for session management
export function useSession() {
  const { user, csrfToken, checkSession, refreshSession } = useAuthContext();
  const [sessionValid, setSessionValid] = useState(true);
  const [checking, setChecking] = useState(false);

  const validateSession = useCallback(async () => {
    setChecking(true);
    try {
      const isValid = await checkSession();
      setSessionValid(isValid);
      return isValid;
    } finally {
      setChecking(false);
    }
  }, [checkSession]);

  // Auto-check session every 5 minutes
  useEffect(() => {
    if (!user) return;

    const interval = setInterval(() => {
      validateSession();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [user, validateSession]);

  return {
    user,
    csrfToken,
    sessionValid,
    checking,
    validateSession,
    refreshSession,
  };
}

// Hook for auth forms
export function useAuthForm() {
  const { signIn, signUp, resetPassword, socialSignIn, error, clearError } = useAuthContext();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = useCallback(async (email: string, password: string, rememberMe = false) => {
    setIsSubmitting(true);
    try {
      await signIn(email, password, rememberMe);
    } finally {
      setIsSubmitting(false);
    }
  }, [signIn]);

  const handleSignUp = useCallback(async (email: string, password: string, name?: string) => {
    setIsSubmitting(true);
    try {
      await signUp(email, password, name);
    } finally {
      setIsSubmitting(false);
    }
  }, [signUp]);

  const handleSocialSignIn = useCallback(async (provider: 'google' | 'facebook' | 'github' | 'twitter' | 'apple') => {
    setIsSubmitting(true);
    try {
      await socialSignIn(provider);
    } finally {
      setIsSubmitting(false);
    }
  }, [socialSignIn]);

  const handleResetPassword = useCallback(async (email: string) => {
    setIsSubmitting(true);
    try {
      await resetPassword(email);
    } finally {
      setIsSubmitting(false);
    }
  }, [resetPassword]);

  return {
    isSubmitting,
    error,
    clearError,
    handleSignIn,
    handleSignUp,
    handleSocialSignIn,
    handleResetPassword,
  };
}

// Hook for making authenticated API calls
export function useAuthenticatedFetch() {
  const { csrfToken, generateFingerprint } = useAuthContext();

  const authFetch = useCallback(async (
    url: string,
    options: RequestInit = {}
  ): Promise<Response> => {
    const headers = new Headers(options.headers);

    // Add CSRF token for state-changing operations
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method || 'GET')) {
      if (csrfToken) {
        headers.set('x-csrf-token', csrfToken);
      }
    }

    // Add fingerprint for enhanced security
    headers.set('x-fingerprint', generateFingerprint());

    return fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Always include cookies
    });
  }, [csrfToken, generateFingerprint]);

  return { authFetch };
}

// Hook for user permissions
export function usePermissions() {
  const { user } = useAuthContext();

  const hasPermission = useCallback((permission: string): boolean => {
    if (!user) return false;
    
    // Super admin has all permissions
    if (user.roles.includes('SUPER_ADMIN')) return true;
    
    // Check specific permissions based on roles
    const rolePermissions: Record<string, string[]> = {
      ADMIN: ['manage_users', 'manage_settings', 'view_analytics', 'manage_products', 'manage_orders'],
      MERCHANT: ['manage_products', 'manage_orders', 'view_analytics'],
      USER: ['view_products', 'create_orders'],
    };

    return user.roles.some(role => 
      rolePermissions[role]?.includes(permission) || false
    );
  }, [user]);

  const hasAnyPermission = useCallback((permissions: string[]): boolean => {
    return permissions.some(permission => hasPermission(permission));
  }, [hasPermission]);

  const hasAllPermissions = useCallback((permissions: string[]): boolean => {
    return permissions.every(permission => hasPermission(permission));
  }, [hasPermission]);

  return {
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  };
}

// Hook for workspace access
export function useWorkspaceAccess(workspaceId?: string) {
  const { user } = useAuthContext();
  const [hasAccess, setHasAccess] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!user || !workspaceId) {
      setHasAccess(false);
      setChecking(false);
      return;
    }

    // Check if user has access to workspace
    const checkAccess = async () => {
      try {
        const response = await fetch(`/api/v2/workspaces/${workspaceId}/access`, {
          credentials: 'include',
        });
        setHasAccess(response.ok);
      } catch (error) {
        console.error('Failed to check workspace access:', error);
        setHasAccess(false);
      } finally {
        setChecking(false);
      }
    };

    checkAccess();
  }, [user, workspaceId]);

  return { hasAccess, checking };
}