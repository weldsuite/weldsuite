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

/**
 * The active workspace id outside React, for an app's own API client to tag
 * its requests with (`X-Weld-Workspace`). Null on every provider except OIDC
 * with `workspaceSource: "header"` (WeldID in membership mode).
 */
export function getActiveWorkspaceId(): string | null {
  return getAuthImplementation().getActiveOrgId?.() ?? null;
}

/**
 * Hook form of `getActiveWorkspaceId()`: the workspace to name on requests
 * and sockets (`X-Weld-Workspace`, the realtime `?workspace=`), only in OIDC
 * header mode (WeldID); null on every other provider, whose token names it.
 */
export function useWorkspaceForRequests(): string | null {
  const implementation = getAuthImplementation();
  const { orgId } = implementation.useAuth();
  return implementation.workspaceIds === 'workspace' ? (orgId ?? null) : null;
}

/**
 * The id the facade knows a workspace by, from a server answer that names it
 * both ways (creating a workspace answers its organization id and
 * `workspaces.id`). Hand this to `setActive`, never the organization id as
 * such: in membership mode (WeldID) the membership list, `orgId` and
 * `X-Weld-Workspace` use `workspaces.id`, which an organization id doesn't
 * match. Null when the answer lacks the id the provider needs. Mirrors the
 * platform's `workspaceRefOf` (`lib/auth`).
 */
export function workspaceRefOf(ids: { organizationId?: string | null; workspaceId?: string | null }): string | null {
  const { organizationId, workspaceId } = ids;
  const ref = getAuthImplementation().workspaceIds === 'workspace' ? workspaceId || organizationId : organizationId;
  return ref || null;
}
