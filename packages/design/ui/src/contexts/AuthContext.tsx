'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  firebaseUid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatar?: string;
  roles: string[];
  storeAccess: StoreAccess[];
  createdAt: Date;
  updatedAt: Date;
}

interface StoreAccess {
  storeId: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'EMPLOYEE' | 'VIEWER';
  permissions: string[];
  grantedAt: number;
  grantedBy: string;
  expiresAt?: number;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (email: string, password: string, name?: string, phoneNumber?: string) => Promise<void>;
  socialLogin: (provider: 'google' | 'facebook' | 'twitter' | 'github' | 'apple') => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  checkStoreAccess: (storeId: string, requiredRole?: string) => boolean;
  hasPermission: (storeId: string, permission: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Fetch current session
  const fetchSession = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/auth/session', {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Failed to fetch session:', err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initialize auth state
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Login
  const login = async (email: string, password: string, rememberMe = false) => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, rememberMe }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      setUser(data.user);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Register
  const register = async (
    email: string,
    password: string,
    name?: string,
    phoneNumber?: string
  ) => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, name, phoneNumber }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      setUser(data.user);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Social login
  const socialLogin = async (
    provider: 'google' | 'facebook' | 'twitter' | 'github' | 'apple'
  ) => {
    setError(null);
    setLoading(true);

    try {
      // Initiate social login flow
      const response = await fetch(`/api/v1/auth/social/${provider}`, {
        method: 'POST',
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Social login failed');
      }

      setUser(data.user);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Logout
  const logout = async () => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Logout failed');
      }

      setUser(null);
      router.push('/login');
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Refresh session
  const refreshSession = async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Session refresh failed');
      }

      setUser(data.user);
    } catch (err) {
      console.error('Failed to refresh session:', err);
      setUser(null);
      router.push('/login');
    }
  };

  // Reset password
  const resetPassword = async (email: string) => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Password reset failed');
      }
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Check store access
  const checkStoreAccess = (storeId: string, requiredRole?: string): boolean => {
    if (!user) return false;

    const access = user.storeAccess.find(sa => sa.storeId === storeId);
    if (!access) return false;

    // Check if access is expired
    if (access.expiresAt && access.expiresAt < Date.now()) return false;

    if (requiredRole) {
      const roleHierarchy: Record<string, number> = {
        OWNER: 5,
        ADMIN: 4,
        MANAGER: 3,
        EMPLOYEE: 2,
        VIEWER: 1,
      };

      const userRoleLevel = roleHierarchy[access.role] || 0;
      const requiredRoleLevel = roleHierarchy[requiredRole] || 0;

      return userRoleLevel >= requiredRoleLevel;
    }

    return true;
  };

  // Check permission
  const hasPermission = (storeId: string, permission: string): boolean => {
    if (!user) return false;

    const access = user.storeAccess.find(sa => sa.storeId === storeId);
    if (!access) return false;

    // Check if permission exists
    return access.permissions.some(p => {
      if (p === permission) return true;
      if (p.endsWith('*')) {
        const prefix = p.slice(0, -1);
        return permission.startsWith(prefix);
      }
      return false;
    });
  };

  // Auto-refresh session before expiry
  useEffect(() => {
    if (!user) return;

    // Refresh session 5 minutes before expiry
    const refreshTime = 5 * 60 * 1000; // 5 minutes
    const timer = setTimeout(() => {
      refreshSession();
    }, refreshTime);

    return () => clearTimeout(timer);
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        login,
        register,
        socialLogin,
        logout,
        refreshSession,
        resetPassword,
        checkStoreAccess,
        hasPermission,
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

// HOC for protecting routes
export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
  options?: {
    redirectTo?: string;
    requiredRole?: string;
    storeId?: string;
  }
) {
  return function AuthenticatedComponent(props: P) {
    const { user, loading } = useAuth();
    const router = useRouter();

    useEffect(() => {
      if (!loading && !user) {
        router.push(options?.redirectTo || '/login');
      }

      if (user && options?.storeId && options?.requiredRole) {
        const hasAccess = user.storeAccess.some(
          sa => sa.storeId === options.storeId && sa.role === options.requiredRole
        );
        
        if (!hasAccess) {
          router.push('/unauthorized');
        }
      }
    }, [user, loading, router]);

    if (loading) {
      return <div>Loading...</div>;
    }

    if (!user) {
      return null;
    }

    return <Component {...props} />;
  };
}