/**
 * The auth facade's shapes: what the platform reads about the signed-in
 * person and their workspaces, whoever signed them in.
 *
 * They are the subset of Clerk's hook results the app actually uses (an
 * inventory of every `@clerk/clerk-react` import fed them), so the Clerk
 * implementation passes Clerk's own objects through untouched and Global
 * behaves exactly as before. The OIDC implementation builds the same shapes
 * from the ID token. A field belongs here only when a provider other than
 * Clerk can fill it; Clerk-only surfaces (sign-in forms, passkeys, 2FA,
 * sessions) stay in `@/lib/auth/clerk`.
 */

import type { ComponentType, ReactNode } from 'react';

export type AuthProviderName = 'clerk' | 'oidc';

/**
 * A bearer token for WeldSuite's APIs. Clerk: the session JWT. OIDC: the
 * access token, refreshed when it has expired. Null when signed out.
 */
export type GetToken = () => Promise<string | null>;

export interface SignOutOptions {
  /** Where to land after signing out. */
  redirectUrl?: string;
}

export type SignOut = (options?: SignOutOptions) => Promise<void>;

interface AuthActions {
  getToken: GetToken;
  signOut: SignOut;
}

/** `useAuth()`: who is signed in, and into which workspace (organization). */
export type AuthState =
  | (AuthActions & {
      isLoaded: false;
      isSignedIn: undefined;
      userId: undefined;
      orgId: undefined;
      orgSlug: undefined;
    })
  | (AuthActions & {
      isLoaded: true;
      isSignedIn: false;
      userId: null;
      orgId: null;
      orgSlug: null;
    })
  | (AuthActions & {
      isLoaded: true;
      isSignedIn: true;
      userId: string;
      /** The active workspace's provider organization id; null before one is chosen. */
      orgId: string | null | undefined;
      orgSlug: string | null | undefined;
    });

export interface AuthEmailAddress {
  emailAddress: string;
}

/** The signed-in person. */
export interface AuthUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  username: string | null;
  imageUrl: string;
  primaryEmailAddress: AuthEmailAddress | null;
  emailAddresses: AuthEmailAddress[];
  /** Re-read the profile from the provider. */
  reload: () => Promise<unknown>;
}

export type UserState =
  | { isLoaded: false; isSignedIn: undefined; user: undefined }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: AuthUser };

/** A workspace as the identity provider knows it (Clerk organization, Zitadel organization). */
export interface AuthOrganization {
  id: string;
  name: string;
  slug: string | null;
  imageUrl: string;
  /** Members as the provider counts them; 0 when the provider does not say. */
  membersCount: number;
  /** The provider's member cap; 0 = no cap. */
  maxAllowedMemberships: number;
  reload: () => Promise<unknown>;
}

export interface OrganizationState {
  isLoaded: boolean;
  organization: AuthOrganization | null | undefined;
}

export interface AuthMembership {
  organization: Pick<AuthOrganization, 'id' | 'name' | 'slug' | 'imageUrl'>;
}

export interface MembershipList {
  data: AuthMembership[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  hasNextPage: boolean;
  fetchNext: (() => void) | undefined;
  /** Re-read the list from the provider (after creating a workspace server-side). */
  revalidate?: () => Promise<unknown>;
}

export interface SetActiveParams {
  /** Provider organization id to make active; null leaves every workspace. */
  organization: string | null;
}

export type SetActive = (params: SetActiveParams) => Promise<void>;

export interface OrganizationListParams {
  userMemberships?: true | { infinite?: boolean; pageSize?: number };
}

export interface OrganizationListState {
  isLoaded: boolean;
  setActive: SetActive | undefined;
  userMemberships: MembershipList;
}

export interface GetAuthTokenOptions {
  /**
   * Wait (up to a few seconds) for the provider to finish loading before
   * answering. For callers that can run before the React tree has mounted,
   * such as route loaders.
   */
  waitForLoad?: boolean;
}

export interface RedirectToSignInOptions {
  intent?: 'sign-in' | 'sign-up';
  /** Where to land once signed in (a path on this origin). */
  returnTo?: string;
}

/** One identity provider behind the facade. Chosen once, before the first render. */
export interface AuthImplementation {
  provider: AuthProviderName;
  Provider: ComponentType<{ children: ReactNode }>;
  useAuth: () => AuthState;
  useUser: () => UserState;
  useOrganization: () => OrganizationState;
  useOrganizationList: (params?: OrganizationListParams) => OrganizationListState;
  /** The bearer token for code outside React (singleton API clients, loaders). */
  getToken: (options?: GetAuthTokenOptions) => Promise<string | null>;
  /**
   * Send the browser to the provider's own sign-in. Only providers without
   * WeldSuite-hosted sign-in pages implement it (OIDC); Clerk renders
   * `/auth/login` itself.
   */
  redirectToSignIn?: (options?: RedirectToSignInOptions) => Promise<void>;
  /** Finish a sign-in redirect on `/auth/sso-callback`; resolves to where to go next. */
  completeSignIn?: () => Promise<string>;
  /** Where the person manages their account (password, MFA) when WeldSuite doesn't. */
  accountUrl?: string;
}
