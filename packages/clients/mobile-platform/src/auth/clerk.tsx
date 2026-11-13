/**
 * The Clerk implementation of the facade (Global, and any server whose
 * `/config.json` names Clerk). Clerk's hooks pass through unchanged, so the
 * apps behave exactly as they did with direct `@clerk/expo` imports.
 */

import {
  ClerkProvider,
  getClerkInstance,
  useAuth as useClerkAuth,
  useOrganization as useClerkOrganization,
  useOrganizationList as useClerkOrganizationList,
  useUser as useClerkUser,
} from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import type { ComponentProps, ReactNode } from 'react';
import { getMobileRuntime } from '../runtime/state';
import type {
  AuthImplementation,
  AuthState,
  ClerkProviderOptions,
  OrganizationListParams,
  OrganizationListState,
  OrganizationState,
  UserState,
} from './types';

type ClerkPasskeys = ComponentProps<typeof ClerkProvider>['__experimental_passkeys'];

function publishableKey(): string {
  const { auth } = getMobileRuntime();
  return auth.provider === 'clerk' ? auth.publishableKey : '';
}

function ClerkAuthProvider({
  children,
  clerk,
}: Readonly<{ children: ReactNode; clerk?: ClerkProviderOptions }>) {
  return (
    // Only Clerk's JS auth flows are used (no native AuthView/UserButton):
    // native client sync races browser SSO on Android and signs people out.
    <ClerkProvider
      publishableKey={publishableKey()}
      tokenCache={tokenCache}
      __experimental_passkeys={clerk?.passkeys as ClerkPasskeys}
      __experimental_disableNativeClientSync
    >
      {children}
    </ClerkProvider>
  );
}

function clerkInstance() {
  try {
    return getClerkInstance();
  } catch {
    // Not initialised yet (before <ClerkProvider> mounted).
    return null;
  }
}

export const clerkAuth: AuthImplementation = {
  provider: 'clerk',
  Provider: ClerkAuthProvider,
  useAuth: () => useClerkAuth() as unknown as AuthState,
  useUser: () => useClerkUser() as unknown as UserState,
  useOrganization: () => useClerkOrganization() as unknown as OrganizationState,
  useOrganizationList: (params?: OrganizationListParams) =>
    useClerkOrganizationList(params) as unknown as OrganizationListState,
  getToken: async () => {
    try {
      return (await clerkInstance()?.session?.getToken()) ?? null;
    } catch {
      return null;
    }
  },
  signOut: async () => {
    await clerkInstance()?.signOut();
  },
};
