/**
 * Clerk behind the auth facade (Global). Every hook hands Clerk's own result
 * straight through, typed as the facade's narrower shape, so screens behave
 * exactly as they did when they imported `@clerk/clerk-react` themselves.
 */

import type { ReactNode } from 'react';
import {
  ClerkProvider,
  useAuth as useClerkAuth,
  useOrganization as useClerkOrganization,
  useOrganizationList as useClerkOrganizationList,
  useUser as useClerkUser,
} from '@clerk/clerk-react';
import { publicEnv } from '@/lib/runtime-config';
import type {
  AuthImplementation,
  AuthState,
  GetAuthTokenOptions,
  OrganizationListParams,
  OrganizationListState,
  OrganizationState,
  UserState,
} from './types';

interface ClerkGlobal {
  loaded?: boolean;
  session?: { getToken: () => Promise<string | null> } | null;
}

function clerkGlobal(): ClerkGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { Clerk?: ClerkGlobal }).Clerk;
}

const LOAD_WAIT_MS = 5000;
const LOAD_POLL_MS = 50;

/**
 * The session token without React: `window.Clerk`, which ClerkProvider
 * installs. With `waitForLoad` it polls until Clerk has loaded (route loaders
 * can run before the provider mounts), otherwise it answers at once.
 */
async function getClerkToken(options?: GetAuthTokenOptions): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (!options?.waitForLoad) {
    const session = clerkGlobal()?.session;
    return session ? session.getToken() : null;
  }
  const start = Date.now();
  while (Date.now() - start < LOAD_WAIT_MS) {
    const clerk = clerkGlobal();
    if (clerk?.loaded) {
      try {
        return (await clerk.session?.getToken()) ?? null;
      } catch {
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
  }
  return null;
}

function ClerkAuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ClerkProvider
      publishableKey={publicEnv('VITE_CLERK_PUBLISHABLE_KEY') ?? ''}
      signInForceRedirectUrl="/"
      signUpForceRedirectUrl="/onboarding"
    >
      {children}
    </ClerkProvider>
  );
}

function useAuth(): AuthState {
  return useClerkAuth();
}

function useUser(): UserState {
  return useClerkUser();
}

function useOrganization(): OrganizationState {
  return useClerkOrganization();
}

function useOrganizationList(params?: OrganizationListParams): OrganizationListState {
  return useClerkOrganizationList(params);
}

export const clerkAuth: AuthImplementation = {
  provider: 'clerk',
  Provider: ClerkAuthProvider,
  useAuth,
  useUser,
  useOrganization,
  useOrganizationList,
  getToken: getClerkToken,
};
