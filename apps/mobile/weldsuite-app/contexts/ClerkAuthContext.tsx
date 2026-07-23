import React, { createContext, useContext, useCallback } from 'react';
import { useAuth, useUser, useOrganization } from '@clerk/expo';

/**
 * User type for Clerk authentication
 */
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

/**
 * Credentials type for API compatibility
 */
export interface ClerkCredentials {
  accessToken: string;
  organizationId?: string;
}

/**
 * Auth context interface
 */
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

/**
 * Provider component that wraps Clerk hooks and provides a unified auth interface
 */
export function ClerkAuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, signOut: clerkSignOut, getToken } = useAuth();
  const { user: clerkUser, isLoaded: isUserLoaded } = useUser();
  const { organization, isLoaded: isOrgLoaded } = useOrganization();

  const isLoading = !isLoaded || !isUserLoaded || !isOrgLoaded;

  // Transform Clerk user to our interface
  const user: ClerkUser | null = clerkUser && isSignedIn ? {
    id: clerkUser.id,
    email: clerkUser.primaryEmailAddress?.emailAddress || '',
    firstName: clerkUser.firstName || undefined,
    lastName: clerkUser.lastName || undefined,
    fullName: clerkUser.fullName || undefined,
    imageUrl: clerkUser.imageUrl || undefined,
    organizationId: organization?.id || undefined,
    organizationRole: undefined, // Would need to get from membership
    organizationSlug: organization?.slug || undefined,
  } : null;

  const signOut = useCallback(async () => {
    await clerkSignOut();
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
    accessToken: null, // Will be fetched async via getCredentials
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

/**
 * Hook to use Clerk auth
 */
export function useClerkAuth() {
  const context = useContext(ClerkAuthContext);
  if (context === undefined) {
    throw new Error('useClerkAuth must be used within a ClerkAuthProvider');
  }
  return context;
}

// Re-export for backward compatibility
export { useClerkAuth as useAuth };
