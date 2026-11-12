/**
 * The mobile auth facade's shapes (ADR SEC-012, work package 4.F4): what the
 * apps read about the signed-in person and their workspaces, whoever signed
 * them in. They mirror the platform's `lib/auth/types.ts` and are the subset
 * of Clerk's hook results the apps use, so the Clerk implementation passes
 * Clerk's own objects through and Global behaves exactly as before. The OIDC
 * implementation builds the same shapes from the tokens.
 */

import type { ReactNode } from 'react';

export type AuthProviderName = 'clerk' | 'oidc';

/** A bearer token for WeldSuite's APIs; null when signed out. */
export type GetToken = () => Promise<string | null>;

export interface SignOutOptions {
  redirectUrl?: string;
}

export type SignOut = (options?: SignOutOptions) => Promise<void>;

interface AuthActions {
  getToken: GetToken;
  signOut: SignOut;
}

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

export interface AuthPhoneNumber {
  phoneNumber: string;
}

export interface AuthUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  username: string | null;
  imageUrl: string;
  primaryEmailAddress: AuthEmailAddress | null | undefined;
  emailAddresses: AuthEmailAddress[];
  phoneNumbers: AuthPhoneNumber[];
  reload: () => Promise<unknown>;
  /**
   * Delete the account. Only where WeldSuite manages accounts (Clerk);
   * elsewhere the person deletes it at the provider (`accountUrl`).
   */
  delete?: () => Promise<unknown>;
}

export type UserState =
  | { isLoaded: false; isSignedIn: undefined; user: undefined }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: AuthUser };

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string | null;
  imageUrl: string;
  membersCount: number;
  maxAllowedMemberships: number;
  reload: () => Promise<unknown>;
}

export interface OrganizationState {
  isLoaded: boolean;
  organization: AuthOrganization | null | undefined;
}

export interface AuthMembership {
  organization: Pick<AuthOrganization, 'id' | 'name' | 'slug' | 'imageUrl'>;
  /** The person's role (Clerk's `org:admin`); absent where the provider doesn't say. */
  role?: string;
}

export interface MembershipList {
  data: AuthMembership[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  hasNextPage: boolean;
  fetchNext: (() => void) | undefined;
  revalidate?: () => Promise<unknown>;
}

export interface SetActiveParams {
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

/** Options for the Clerk implementation, set by the app. */
export interface ClerkProviderOptions {
  /** `@clerk/expo/passkeys`'s adapter, for apps that offer passkey sign-in. */
  passkeys?: unknown;
}

export interface HostedSignInOptions {
  intent?: 'sign-in' | 'sign-up';
}

/** The result of a hosted sign-in: the person may close the browser. */
export type HostedSignInResult = 'signed-in' | 'cancelled';

/** One identity provider behind the facade. Chosen once per JS lifetime. */
export interface AuthImplementation {
  provider: AuthProviderName;
  Provider: (props: { children: ReactNode; clerk?: ClerkProviderOptions }) => ReactNode;
  useAuth: () => AuthState;
  useUser: () => UserState;
  useOrganization: () => OrganizationState;
  useOrganizationList: (params?: OrganizationListParams) => OrganizationListState;
  /** The bearer token for code outside React (API clients). */
  getToken: () => Promise<string | null>;
  /** Sign out outside React (switching server). */
  signOut: () => Promise<void>;
  /** Sign in on the provider's own pages (OIDC). Clerk renders its own forms. */
  signIn?: (options?: HostedSignInOptions) => Promise<HostedSignInResult>;
  /** Where the person manages their account when WeldSuite doesn't. */
  accountUrl?: string;
}
