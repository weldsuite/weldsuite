'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Auth0User {
  email: string;
  name?: string;
  picture?: string;
  sub: string;
  email_verified?: boolean;
}

interface Auth0ContextType {
  user: Auth0User | null;
  loading: boolean;
  error: Error | null;
  login: (returnTo?: string) => void;
  logout: (returnTo?: string) => void;
  refreshUser: () => Promise<void>;
}

const Auth0Context = createContext<Auth0ContextType | undefined>(undefined);

export function Auth0Provider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Auth0User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const router = useRouter();

  const fetchUser = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/auth/me');
      
      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
      } else if (response.status === 401) {
        setUser(null);
      } else {
        throw new Error('Failed to fetch user');
      }
    } catch (err) {
      setError(err as Error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const login = (returnTo?: string) => {
    const loginUrl = new URL('/api/auth/login', window.location.origin);
    if (returnTo) {
      loginUrl.searchParams.set('returnTo', returnTo);
    }
    window.location.href = loginUrl.toString();
  };

  const logout = (returnTo?: string) => {
    const logoutUrl = new URL('/api/auth/logout', window.location.origin);
    if (returnTo) {
      logoutUrl.searchParams.set('returnTo', returnTo);
    }
    window.location.href = logoutUrl.toString();
  };

  const refreshUser = async () => {
    await fetchUser();
  };

  return (
    <Auth0Context.Provider
      value={{
        user,
        loading,
        error,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </Auth0Context.Provider>
  );
}

export function useAuth0() {
  const context = useContext(Auth0Context);
  if (context === undefined) {
    throw new Error('useAuth0 must be used within an Auth0Provider');
  }
  return context;
}

// HOC for protecting pages
export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
  options?: { redirectTo?: string }
) {
  return function ProtectedComponent(props: P) {
    const { user, loading } = useAuth0();
    const router = useRouter();

    useEffect(() => {
      if (!loading && !user) {
        const loginUrl = new URL('/api/auth/login', window.location.origin);
        loginUrl.searchParams.set('returnTo', options?.redirectTo || window.location.pathname);
        window.location.href = loginUrl.toString();
      }
    }, [loading, user, router]);

    if (loading) {
      return (
        <div className="flex items-center justify-center h-screen">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      );
    }

    if (!user) {
      return null;
    }

    return <Component {...props} />;
  };
}