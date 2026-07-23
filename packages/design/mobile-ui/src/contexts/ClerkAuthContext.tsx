import React, { createContext, useContext, useCallback } from 'react';
import { useAuth, useUser, useOrganization } from '@clerk/expo';

export interface ClerkUser {
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

export interface ClerkCredentials {
  accessToken: string;
  organizationId?: string;
}

interface ClerkAuthContextType {
  user: ClerkUser | null;
  isLoading: boolean;
  isSignedIn: boolean;
  accessToken: string | null;
  organizationId: string | null;
  signOut: () => Promise<void>;
  getCredentials: () => Promise<ClerkCredentials | null>;
  getToken: () => Promise<string | null>;
}

const ClerkAuthContext = createContext<ClerkAuthContextType | undefined>(undefined);

export function ClerkAuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, signOut: clerkSignOut, getToken } = useAuth();
  const { user: clerkUser, isLoaded: isUserLoaded } = useUser();
  const { organization, isLoaded: isOrgLoaded } = useOrganization();

  const isLoading = !isLoaded || !isUserLoaded;

  const user: ClerkUser | null = clerkUser && isSignedIn ? {
    id: clerkUser.id,
    email: clerkUser.primaryEmailAddress?.emailAddress || '',
    firstName: clerkUser.firstName || undefined,
    lastName: clerkUser.lastName || undefined,
    fullName: clerkUser.fullName || undefined,
    imageUrl: clerkUser.imageUrl || undefined,
    organizationId: organization?.id || undefined,
    organizationRole: undefined,
    organizationSlug: organization?.slug || undefined,
  } : null;

  const signOut = useCallback(async () => {
    try {
      await clerkSignOut();
    } catch (error) {
      console.error('Sign out failed:', error);
      // Force clear the signed-in state even if the API call fails
      await clerkSignOut({ redirectUrl: '/' }).catch(() => {});
    }
  }, [clerkSignOut]);

  const getCredentials = useCallback(async (): Promise<ClerkCredentials | null> => {
    if (!isSignedIn) return null;

    try {
      const token = await getToken();
      if (!token) return null;

      return {
        accessToken: token,
        organizationId: organization?.id || undefined,
      };
    } catch (error) {
      console.error('Failed to get Clerk credentials:', error);
      return null;
    }
  }, [isSignedIn, getToken, organization]);

  const getTokenAsync = useCallback(async (): Promise<string | null> => {
    if (!isSignedIn) return null;

    try {
      return await getToken();
    } catch (error) {
      console.error('Failed to get Clerk token:', error);
      return null;
    }
  }, [isSignedIn, getToken]);

  const value: ClerkAuthContextType = {
    user,
    isLoading,
    isSignedIn: !!isSignedIn,
    accessToken: null,
    organizationId: organization?.id || null,
    signOut,
    getCredentials,
    getToken: getTokenAsync,
  };

  return (
    <ClerkAuthContext.Provider value={value}>
      {children}
    </ClerkAuthContext.Provider>
  );
}

export function useClerkAuth() {
  const context = useContext(ClerkAuthContext);
  if (context === undefined) {
    throw new Error('useClerkAuth must be used within a ClerkAuthProvider');
  }
  return context;
}

export { useClerkAuth as useAuth };
