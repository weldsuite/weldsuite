/**
 * `@weldsuite/mobile-platform/auth`: the mobile auth facade (ADR SEC-012,
 * work package 4.F4). The apps import sign-in state from here, never from
 * `@clerk/expo` (the ESLint rule in each app enforces it outside Clerk-only
 * screens). One provider backs it per JS lifetime, chosen from the booted
 * runtime (`getMobileRuntime().auth`):
 *
 * - **clerk** (Global): `clerk.tsx`, Clerk's hooks passed through.
 * - **oidc** (EU, self-hosted): `oidc/`, PKCE in the system browser sheet.
 *
 * Same API as the platform's `lib/auth`:
 * `<AuthProvider>`, `useAuth()`, `useUser()`, `useOrganization()`,
 * `useOrganizationList()`, `getAuthToken()`, `useAuthProvider()`,
 * `<ClerkOnly>`, plus `<AuthLoaded>` / `<AuthLoading>` (for `ClerkLoaded` /
 * `ClerkLoading`) and `useHostedSignIn()` for providers that sign in on
 * their own pages.
 */

import type { ReactNode } from 'react';
import { getAuthImplementation } from './active';
import type {
  AuthProviderName,
  AuthState,
  ClerkProviderOptions,
  HostedSignInOptions,
  HostedSignInResult,
  OrganizationListParams,
  OrganizationListState,
  OrganizationState,
  UserState,
} from './types';

export type * from './types';
export { setAuthImplementation, signOutActive } from './active';
export { OidcSignInError } from './oidc/session';

/** Mounts the active provider. Render it under `<ServerRuntimeGate>`. */
export function AuthProvider({
  children,
  clerk,
}: Readonly<{ children: ReactNode; clerk?: ClerkProviderOptions }>) {
  const { Provider } = getAuthImplementation();
  return <Provider clerk={clerk}>{children}</Provider>;
}

export function useAuth(): AuthState {
  return getAuthImplementation().useAuth();
}

export function useUser(): UserState {
  return getAuthImplementation().useUser();
}

export function useOrganization(): OrganizationState {
  return getAuthImplementation().useOrganization();
}

export function useOrganizationList(params?: OrganizationListParams): OrganizationListState {
  return getAuthImplementation().useOrganizationList(params);
}

/** The bearer token outside React (API clients). Inside components use `useAuth().getToken`. */
export function getAuthToken(): Promise<string | null> {
  return getAuthImplementation().getToken();
}

export function getAuthProvider(): AuthProviderName {
  return getAuthImplementation().provider;
}

/** Hook form of `getAuthProvider()`; constant for the JS lifetime. */
export function useAuthProvider(): AuthProviderName {
  return getAuthImplementation().provider;
}

/** Renders `children` only once the provider has loaded (Clerk's `<ClerkLoaded>`). */
export function AuthLoaded({ children }: Readonly<{ children: ReactNode }>) {
  const { isLoaded } = useAuth();
  return isLoaded ? <>{children}</> : null;
}

/** Renders `children` only while the provider loads (Clerk's `<ClerkLoading>`). */
export function AuthLoading({ children }: Readonly<{ children: ReactNode }>) {
  const { isLoaded } = useAuth();
  return isLoaded ? null : <>{children}</>;
}

/** Clerk-only screens (sign-in forms, passkeys, account deletion); `fallback` elsewhere. */
export function ClerkOnly({ children, fallback = null }: Readonly<{ children: ReactNode; fallback?: ReactNode }>) {
  return <>{useAuthProvider() === 'clerk' ? children : fallback}</>;
}

export interface HostedSignIn {
  signIn: (options?: HostedSignInOptions) => Promise<HostedSignInResult>;
  /** Where the person manages their account (password, MFA, deletion). */
  accountUrl: string | undefined;
}

/** Sign-in on the provider's own pages; null with Clerk, which renders its own forms. */
export function useHostedSignIn(): HostedSignIn | null {
  const implementation = getAuthImplementation();
  const { signIn } = implementation;
  if (!signIn) return null;
  return { signIn, accountUrl: implementation.accountUrl };
}
