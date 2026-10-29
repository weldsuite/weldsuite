/**
 * The auth facade (P4 work package 4.F1, ADR SEC-012).
 *
 * The platform imports sign-in state from here, never from `@clerk/clerk-react`
 * (ESLint enforces it outside `lib/auth`). One identity provider backs it per
 * deployment, chosen once before the first render from the runtime config
 * (`lib/runtime-config.ts`, `auth.provider`):
 *
 * - **clerk** (Global, and the default when no runtime config says otherwise):
 *   `clerk-adapter.tsx`, Clerk's hooks passed through unchanged.
 * - **oidc** (EU on Zitadel, self-hosted with any OIDC provider): `oidc/`,
 *   authorization code + PKCE with `oidc-client-ts`, loaded only on those
 *   deployments so Global's bundle doesn't carry it.
 *
 * API:
 * - `<AuthProvider>`: mounts the active provider (replaces `<ClerkProvider>`).
 * - `useAuth()`: `{ isLoaded, isSignedIn, userId, orgId, orgSlug, getToken, signOut }`.
 *   `getToken()` resolves to the bearer token the API clients send.
 * - `useUser()`: `{ isLoaded, isSignedIn, user }`, the person's name, email, avatar.
 * - `useOrganization()`: the active workspace as the provider knows it.
 * - `useOrganizationList()`: the person's workspaces and `setActive()` to switch.
 * - `getAuthToken()`: the bearer token outside React.
 * - `useAuthProvider()` / `getAuthProvider()`: `'clerk' | 'oidc'`.
 * - `<ClerkOnly>`: renders Clerk-specific screens (sign-in forms, passkeys,
 *   2FA, sessions) only on Clerk, a fallback elsewhere.
 * - `redirectToSignIn()` / `completeSignIn()` / `getAccountUrl()`: the
 *   provider-hosted sign-in that replaces those screens on OIDC.
 *
 * Clerk-only hooks and types (`useSignIn`, `useReverification`, …) live in
 * `@/lib/auth/clerk`; a screen that needs them renders inside `<ClerkOnly>`.
 */

import type { ReactNode } from 'react';
import { clerkAuth } from './clerk-adapter';
import type {
  AuthImplementation,
  AuthProviderName,
  AuthState,
  GetAuthTokenOptions,
  OrganizationListParams,
  OrganizationListState,
  OrganizationState,
  RedirectToSignInOptions,
  UserState,
} from './types';

export type {
  AuthEmailAddress,
  AuthImplementation,
  AuthMembership,
  AuthOrganization,
  AuthProviderName,
  AuthState,
  AuthUser,
  GetAuthTokenOptions,
  GetToken,
  MembershipList,
  OrganizationListParams,
  OrganizationListState,
  OrganizationState,
  RedirectToSignInOptions,
  SetActive,
  SetActiveParams,
  SignOut,
  SignOutOptions,
  UserState,
} from './types';

let active: AuthImplementation = clerkAuth;

/**
 * Pick the identity provider. Boot calls it once, before the first render;
 * changing it later would change which hooks run, so nothing else may.
 */
export function setAuthImplementation(implementation: AuthImplementation): void {
  active = implementation;
}

/** The provider behind the facade. */
export function getAuthProvider(): AuthProviderName {
  return active.provider;
}

/** Hook form of `getAuthProvider()`; constant for the page's lifetime. */
export function useAuthProvider(): AuthProviderName {
  return active.provider;
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { Provider } = active;
  return <Provider>{children}</Provider>;
}

export function useAuth(): AuthState {
  return active.useAuth();
}

export function useUser(): UserState {
  return active.useUser();
}

export function useOrganization(): OrganizationState {
  return active.useOrganization();
}

export function useOrganizationList(params?: OrganizationListParams): OrganizationListState {
  return active.useOrganizationList(params);
}

/**
 * The bearer token for code outside React: singleton API clients and route
 * loaders. Inside components use `useAuth().getToken`.
 */
export function getAuthToken(options?: GetAuthTokenOptions): Promise<string | null> {
  return active.getToken(options);
}

/** True when sign-in happens on the provider's own pages rather than WeldSuite's. */
export function usesHostedSignIn(): boolean {
  return Boolean(active.redirectToSignIn);
}

/** Send the browser to the provider's sign-in (OIDC). A no-op on Clerk, which has its own pages. */
export async function redirectToSignIn(options?: RedirectToSignInOptions): Promise<void> {
  await active.redirectToSignIn?.(options);
}

/** Finish a provider redirect on `/auth/sso-callback`; resolves to the path to continue on. */
export async function completeSignIn(): Promise<string> {
  return active.completeSignIn ? active.completeSignIn() : '/';
}

/** Where the person manages their account when the provider owns it (OIDC); undefined on Clerk. */
export function getAccountUrl(): string | undefined {
  return active.accountUrl;
}

/**
 * Render Clerk-specific screens only when Clerk is the provider. Their hooks
 * (`@/lib/auth/clerk`) throw outside `<ClerkProvider>`, so on other providers
 * the fallback renders instead and the children never mount.
 */
export function ClerkOnly({ children, fallback = null }: Readonly<{ children: ReactNode; fallback?: ReactNode }>) {
  return <>{active.provider === 'clerk' ? children : fallback}</>;
}
