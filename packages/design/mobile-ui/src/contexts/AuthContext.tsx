/**
 * The signed-in person and their session, for the apps' screens and API
 * wiring, whoever signed them in: Clerk on Global, the server's OIDC
 * provider on EU and self-hosted. Built on the auth facade
 * (`@weldsuite/mobile-platform/auth`); it replaced `ClerkAuthContext` and
 * kept its shape.
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useAuth, useOrganization, useUser } from '@weldsuite/mobile-platform/auth';

export interface SessionUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  imageUrl?: string;
  organizationId?: string;
  organizationRole?: string;
  organizationSlug?: string;
}

export interface SessionCredentials {
  accessToken: string;
  organizationId?: string;
}

export interface AuthSessionContextType {
  user: SessionUser | null;
  isLoading: boolean;
  isSignedIn: boolean;
  accessToken: string | null;
  organizationId: string | null;
  signOut: () => Promise<void>;
  getCredentials: () => Promise<SessionCredentials | null>;
  getToken: () => Promise<string | null>;
}

const AuthSessionContext = createContext<AuthSessionContextType | undefined>(undefined);

export function AuthSessionProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { isLoaded, isSignedIn, signOut: providerSignOut, getToken } = useAuth();
  const { user: authUser, isLoaded: isUserLoaded } = useUser();
  const { organization } = useOrganization();

  const isLoading = !isLoaded || !isUserLoaded;

  const user = useMemo(
    (): SessionUser | null =>
      authUser && isSignedIn
        ? {
            id: authUser.id,
            email: authUser.primaryEmailAddress?.emailAddress || '',
            firstName: authUser.firstName || undefined,
            lastName: authUser.lastName || undefined,
            fullName: authUser.fullName || undefined,
            imageUrl: authUser.imageUrl || undefined,
            organizationId: organization?.id || undefined,
            organizationRole: undefined,
            organizationSlug: organization?.slug || undefined,
          }
        : null,
    [authUser, isSignedIn, organization?.id, organization?.slug],
  );

  const signOut = useCallback(async () => {
    try {
      await providerSignOut();
    } catch (error) {
      console.error('Sign out failed:', error);
      // Force clear the signed-in state even if the API call fails.
      await providerSignOut({ redirectUrl: '/' }).catch(() => {});
    }
  }, [providerSignOut]);

  const getCredentials = useCallback(async (): Promise<SessionCredentials | null> => {
    if (!isSignedIn) return null;
    try {
      const token = await getToken();
      if (!token) return null;
      return { accessToken: token, organizationId: organization?.id || undefined };
    } catch (error) {
      console.error('Failed to get session credentials:', error);
      return null;
    }
  }, [isSignedIn, getToken, organization]);

  const getTokenAsync = useCallback(async (): Promise<string | null> => {
    if (!isSignedIn) return null;
    try {
      return await getToken();
    } catch (error) {
      console.error('Failed to get session token:', error);
      return null;
    }
  }, [isSignedIn, getToken]);

  const value = useMemo(
    (): AuthSessionContextType => ({
      user,
      isLoading,
      isSignedIn: !!isSignedIn,
      accessToken: null,
      organizationId: organization?.id || null,
      signOut,
      getCredentials,
      getToken: getTokenAsync,
    }),
    [user, isLoading, isSignedIn, organization?.id, signOut, getCredentials, getTokenAsync],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextType {
  const context = useContext(AuthSessionContext);
  if (context === undefined) {
    throw new Error('useAuthSession must be used within an AuthSessionProvider');
  }
  return context;
}
