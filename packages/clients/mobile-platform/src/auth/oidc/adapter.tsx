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

const deps: OidcSessionDeps = {
  fetchImpl: (input, init) => fetch(input, init),
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

function toOrganization(org: { id: string; name: string }): AuthOrganization {
  return {
    id: org.id,
    name: org.name,
    slug: null,
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
      organization: { id: org.id, name: org.name, slug: null, imageUrl: '' },
    }));
    return {
      isLoaded: snapshot.isLoaded,
      setActive: snapshot.isLoaded ? setActive : undefined,
      userMemberships: {
        data: snapshot.isLoaded ? data : undefined,
        isLoading: !snapshot.isLoaded,
        isFetching: false,
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
  signIn: (options) => getSession().signIn({ intent: options?.intent }),
  get accountUrl() {
    const { auth } = getMobileRuntime();
    return auth.provider === 'oidc' ? auth.accountUrl : undefined;
  },
};
