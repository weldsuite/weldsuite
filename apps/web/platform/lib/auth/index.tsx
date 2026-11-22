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
 * - `workspaceRefOf()`: which of a new workspace's ids to activate and link
 *   to (`workspaces.id` in membership mode, the organization id elsewhere).
 * - `useAuthProvider()` / `getAuthProvider()`: `'clerk' | 'oidc'`.
 * - `<ClerkOnly>`: renders Clerk-specific screens (sign-in forms, passkeys,
 *   2FA, sessions) only on Clerk, a fallback elsewhere.
 * - `redirectToSignIn()` / `completeSignIn()` / `getAccountUrl()`: the
 *   OIDC redirect that starts and finishes a sign-in on OIDC.
 * - `isWeldIdProvider()`: the OIDC provider is WeldID, WeldSuite's own.
 * - `usesPlatformSignIn()`: on OIDC, WeldSuite shows the sign-in screens
 *   itself (the ones Global shows, `lib/auth/oidc/sign-in-api.ts`) rather
 *   than the provider.
 * - `usesBrowserSignIn()` / `signInWithBrowser()` / `cancelBrowserSignIn()`:
 *   inside the desktop shell on OIDC, sign-in happens in the system browser
 *   (RFC 8252 loopback; `lib/auth/oidc/browser-sign-in.ts`), started from a
 *   button on the sign-in screen. Global's desktop sign-in (a Clerk ticket by
 *   deep link) is unchanged.
 *
 * Clerk-only hooks and types (`useSignIn`, `useReverification`, …) live in
 * `@/lib/auth/clerk`; a screen that needs them renders inside `<ClerkOnly>`.
 */

import type { ReactNode } from 'react';
import { clerkAuth } from './clerk-adapter';
import { BrowserSignInError } from './oidc/browser-sign-in';
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
export { BrowserSignInError, type BrowserSignInFailure } from './oidc/browser-sign-in';

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

/**
 * True when WeldSuite shows its own sign-in screens over an OIDC provider
 * (`auth.signIn: "platform"` in `/config.json`, ADR SEC-016): the provider
 * then sends a sign-in back to `/auth/login` rather than showing its pages.
 */
export function usesPlatformSignIn(): boolean {
  return active.platformSignIn === true;
}

/** Send the browser to the provider's sign-in (OIDC). A no-op on Clerk, which has its own pages. */
export async function redirectToSignIn(options?: RedirectToSignInOptions): Promise<void> {
  await active.redirectToSignIn?.(options);
}

/**
 * True inside the desktop shell on OIDC: the sign-in screens offer a button
 * that signs in through the system browser instead of sending this window to
 * the provider. Constant for the page's lifetime.
 */
export function usesBrowserSignIn(): boolean {
  return Boolean(active.signInWithBrowser);
}

/**
 * Sign in through the system browser (desktop shell on OIDC). Resolves once
 * signed in, with the page on its way to `returnTo`; rejects with
 * `BrowserSignInError` (`reason`: cancelled, timeout, failed).
 */
export async function signInWithBrowser(options?: RedirectToSignInOptions): Promise<void> {
  if (!active.signInWithBrowser) throw new BrowserSignInError('failed');
  await active.signInWithBrowser(options);
}

/** Stop a sign-in still waiting for the browser. A no-op when none is. */
export function cancelBrowserSignIn(): void {
  active.cancelBrowserSignIn?.();
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
 * True when WeldID, WeldSuite's own provider, signs people in
 * (`auth.identityProvider: "weldid"`): the account lives in WeldID, not with
 * a customer's own identity provider.
 */
export function isWeldIdProvider(): boolean {
  return active.identityProvider === 'weldid';
}

/**
 * The active workspace id outside React (`lib/api/workspace-header.ts`).
 * Null on every provider except OIDC with `auth.workspaceSource: "header"`
 * (WeldID in membership mode), where it is the `X-Weld-Workspace` value.
 */
export function getActiveWorkspaceId(): string | null {
  return active.getActiveOrgId?.() ?? null;
}

/**
 * The id the facade knows a workspace by, from a server answer that names it
 * both ways (creating a workspace answers its organization id and
 * `workspaces.id`). Hand this to `setActive`, `setPendingOrganization` and
 * `workspacePath`, never the organization id as such: in membership mode
 * (WeldID) the membership list, `orgId` and `X-Weld-Workspace` use
 * `workspaces.id`, and an organization id there matches no workspace, so
 * the URL kept it instead of the workspace's slug. Null when the answer
 * lacks the id the provider needs.
 */
export function workspaceRefOf(ids: { organizationId?: string | null; workspaceId?: string | null }): string | null {
  const { organizationId, workspaceId } = ids;
  // Membership mode takes either (the backend resolves both); the other
  // providers switch by organization, so only that id will do.
  const ref = active.workspaceIds === 'workspace' ? workspaceId || organizationId : organizationId;
  return ref || null;
}

/**
 * Render Clerk-specific screens only when Clerk is the provider. Their hooks
 * (`@/lib/auth/clerk`) throw outside `<ClerkProvider>`, so on other providers
 * the fallback renders instead and the children never mount.
 */
export function ClerkOnly({ children, fallback = null }: Readonly<{ children: ReactNode; fallback?: ReactNode }>) {
  return <>{active.provider === 'clerk' ? children : fallback}</>;
}
