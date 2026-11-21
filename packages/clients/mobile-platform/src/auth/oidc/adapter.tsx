/**
 * The OIDC implementation of the facade: `OidcMobileSession` wired to the
 * device (system browser sheet, secure store, crypto) and read by React
 * through `useSyncExternalStore`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { parseWorkspaceDirectory, type OidcOrganization } from '@weldsuite/app-api-client/auth/oidc-claims';
import { getMobileRuntime } from '../../runtime/state';
import type {
  AuthImplementation,
  AuthMembership,
  AuthOrganization,
  AuthState,
  AuthUser,
  OrganizationListState,
  OrganizationState,
  UserState,
} from '../types';
import { OidcMobileSession, storageIdFor, type OidcSessionDeps, type OidcSnapshot } from './session';

/**
 * WeldSuite's list of the person's workspaces, `GET /api/workspaces` on the
 * server the app runs against (`header` mode: the token names none).
 */
export async function loadWorkspacesFromServer(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcOrganization[] | null> {
  try {
    const res = await fetchImpl(`${getMobileRuntime().apiOrigin}/api/workspaces`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return parseWorkspaceDirectory(await res.json());
  } catch {
    return null;
  }
}

const deps: OidcSessionDeps = {
  fetchImpl: (input, init) => fetch(input, init),
  loadWorkspaces: (token) => loadWorkspacesFromServer(token),
  secureStore: SecureStore,
  cacheStore: AsyncStorage,
  openAuthSession: (url, redirectUri) => WebBrowser.openAuthSessionAsync(url, redirectUri),
  randomBytes: (size) => Crypto.getRandomBytes(size),
  sha256Base64: (input) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
};

let session: OidcMobileSession | null = null;

/** The redirect URI the native client must list: `<scheme>://sso-callback`. */
export function oidcRedirectUri(): string {
  const { app } = getMobileRuntime();
  return `${app.scheme ?? app.code}://sso-callback`;
}

function getSession(): OidcMobileSession {
  if (session) return session;
  const runtime = getMobileRuntime();
  const { auth } = runtime;
  if (auth.provider !== 'oidc') throw new Error('This server does not use OIDC sign-in');
  session = new OidcMobileSession(
    {
      issuer: auth.issuer,
      clientId: auth.clientId,
      redirectUri: oidcRedirectUri(),
      audience: auth.audience,
      orgClaim: auth.orgClaim,
      scopes: auth.scopes,
      audienceScope: auth.audienceScope,
      organizationScope: auth.organizationScope,
      workspaceSource: auth.workspaceSource,
      storageId: storageIdFor(runtime.server.origin ?? runtime.apiOrigin),
    },
    deps,
  );
  return session;
}

function useSnapshot(): OidcSnapshot {
  const current = getSession();
  return useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot);
}

function OidcProvider({ children }: Readonly<{ children: ReactNode }>) {
  useEffect(() => {
    void getSession().init();
  }, []);
  return <>{children}</>;
}

const getToken = () => getSession().getToken();
const signOut = () => getSession().signOut();
const reload = () => getSession().reload();

function useOidcAuth(): AuthState {
  const snapshot = useSnapshot();
  return useMemo((): AuthState => {
    if (!snapshot.isLoaded) {
      return { isLoaded: false, isSignedIn: undefined, userId: undefined, orgId: undefined, orgSlug: undefined, getToken, signOut };
    }
    if (!snapshot.person) {
      return { isLoaded: true, isSignedIn: false, userId: null, orgId: null, orgSlug: null, getToken, signOut };
    }
    return {
      isLoaded: true,
      isSignedIn: true,
      userId: snapshot.person.id,
      orgId: snapshot.activeOrgId,
      orgSlug: null,
      getToken,
      signOut,
    };
  }, [snapshot]);
}

function useOidcUser(): UserState {
  const snapshot = useSnapshot();
  return useMemo((): UserState => {
    if (!snapshot.isLoaded) return { isLoaded: false, isSignedIn: undefined, user: undefined };
    const person = snapshot.person;
    if (!person) return { isLoaded: true, isSignedIn: false, user: null };
    const email = person.email ? { emailAddress: person.email } : null;
    const user: AuthUser = {
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      fullName: person.fullName,
      username: person.username,
      imageUrl: person.imageUrl,
      primaryEmailAddress: email,
      emailAddresses: email ? [email] : [],
      phoneNumbers: [],
      reload,
    };
    return { isLoaded: true, isSignedIn: true, user };
  }, [snapshot]);
}

function toOrganization(org: OidcOrganization): AuthOrganization {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug ?? null,
    imageUrl: '',
    membersCount: 0,
    maxAllowedMemberships: 0,
    reload,
  };
}

function useOidcOrganization(): OrganizationState {
  const snapshot = useSnapshot();
  return useMemo((): OrganizationState => {
    const active = snapshot.organizations.find((org) => org.id === snapshot.activeOrgId);
    return { isLoaded: snapshot.isLoaded, organization: active ? toOrganization(active) : null };
  }, [snapshot]);
}

const setActive = async ({ organization }: { organization: string | null }) => {
  await getSession().setActiveOrganization(organization);
};

function useOidcOrganizationList(): OrganizationListState {
  const snapshot = useSnapshot();
  return useMemo((): OrganizationListState => {
    const data: AuthMembership[] = snapshot.organizations.map((org) => ({
      organization: { id: org.id, name: org.name, slug: org.slug ?? null, imageUrl: '' },
    }));
    // WeldID: until the first workspace read is back, an empty list isn't "no workspace".
    const loading = !snapshot.isLoaded || snapshot.isLoadingWorkspaces;
    return {
      isLoaded: snapshot.isLoaded,
      setActive: snapshot.isLoaded ? setActive : undefined,
      userMemberships: {
        data: loading ? undefined : data,
        isLoading: loading,
        isFetching: snapshot.isLoadingWorkspaces,
        hasNextPage: false,
        fetchNext: undefined,
        revalidate: reload,
      },
    };
  }, [snapshot]);
}

export const oidcAuth: AuthImplementation = {
  provider: 'oidc',
  Provider: OidcProvider,
  useAuth: useOidcAuth,
  useUser: useOidcUser,
  useOrganization: useOidcOrganization,
  useOrganizationList: useOidcOrganizationList,
  getToken,
  signOut,
  signIn: (options) => getSession().signIn({ intent: options?.intent, locale: options?.locale }),
  get accountUrl() {
    const { auth } = getMobileRuntime();
    return auth.provider === 'oidc' ? (auth.accountUrl ?? undefined) : undefined;
  },
  getActiveOrgId: () => getSession().getSnapshot().activeOrgId,
  get workspaceIds() {
    const { auth } = getMobileRuntime();
    return auth.provider === 'oidc' && auth.workspaceSource === 'header' ? 'workspace' : 'organization';
  },
};
