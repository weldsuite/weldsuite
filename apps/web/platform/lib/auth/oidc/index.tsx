/**
 * OIDC behind the auth facade (P4 work package 4.F5, ADR SEC-012): the EU
 * edition on Zitadel and self-hosted deployments on their own provider.
 * Selected by the `auth` block the Rust backend serves in `/config.json`
 * (`lib/runtime-config.ts`):
 *
 * ```json
 * { "auth": { "provider": "oidc", "issuer": "https://id.example.eu", "clientId": "…",
 *             "audience": "<projectId>", "orgClaim": "urn:zitadel:iam:org:project:<projectId>:roles" } }
 * ```
 *
 * Authorization code + PKCE (`oidc-client-ts`), a public client: register a
 * "User Agent" / SPA application with redirect URI
 * `https://<platform>/auth/sso-callback` and post-logout URI
 * `https://<platform>/`. Sign-in and sign-up happen on the provider's pages;
 * `/auth/login` and `/auth/register` only redirect there. The person comes
 * from the ID token's profile claims; workspaces and the active one from the
 * org claim and the organization-scoped token requests in `session.ts`.
 *
 * ## Running it locally against Zitadel
 *
 * 1. Start Zitadel with its compose file
 *    (https://zitadel.com/docs/self-hosting/deploy/compose):
 *    `docker compose up` serves the console on http://localhost:8080
 *    (first admin: `zitadel-admin@zitadel.localhost` / the password in the
 *    compose file).
 * 2. In the console create a project "WeldSuite", tick "Assert roles on
 *    authentication", add a role (e.g. `member`), and add an application of
 *    type User Agent with PKCE, redirect URI
 *    `http://localhost:3000/auth/sso-callback`, post-logout URI
 *    `http://localhost:3000/`, and "Development mode" on (allows http).
 * 3. Create an organization per workspace, grant the project to it, and give
 *    a user that role in it (Authorizations). One user in two organizations
 *    exercises workspace switching.
 * 4. Run the Rust backend with `AUTH_PROVIDER=oidc`, `OIDC_ISSUER=http://localhost:8080`,
 *    `OIDC_AUDIENCE=<project id>`, `OIDC_ORG_CLAIM=urn:zitadel:iam:org:project:<project id>:roles`
 *    and `OIDC_WEB_CLIENT_ID=<the app's client id>`, and serve the platform on
 *    the same origin so `/config.json` comes from it. Without the backend, put
 *    the same `auth` block in `apps/web/platform/public/config.json` (not
 *    committed) and run `pnpm --filter platform dev`: the shell signs in, API
 *    calls are refused.
 */

import { useSyncExternalStore, type ReactNode } from 'react';
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
import type { OidcOrganization } from './claims';
import { OidcSession, type OidcSessionConfig, type OidcSessionOptions, type OidcSnapshot } from './session';

const NOT_LOADED = {
  isLoaded: false,
  isSignedIn: undefined,
  userId: undefined,
  orgId: undefined,
  orgSlug: undefined,
} as const;

const SIGNED_OUT = { isLoaded: true, isSignedIn: false, userId: null, orgId: null, orgSlug: null } as const;

const EMPTY_MEMBERSHIPS = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  hasNextPage: false,
  fetchNext: undefined,
};

/** Build the OIDC implementation of the facade. */
export function createOidcAuth(config: OidcSessionConfig, options?: OidcSessionOptions): AuthImplementation {
  const session = new OidcSession(config, options);
  void session.init();

  const getToken = () => session.getToken();
  const signOut = (opts?: { redirectUrl?: string }) => session.signOut(opts?.redirectUrl);
  const reload = () => session.reload();
  const setActive = ({ organization }: { organization: string | null }) =>
    session.setActiveOrganization(organization);

  // Derived objects are cached per snapshot so hooks hand out stable references.
  let cachedFor: OidcSnapshot | null = null;
  let derived: {
    auth: AuthState;
    user: UserState;
    organization: OrganizationState;
    list: OrganizationListState;
  } | null = null;

  const toOrganization = (org: OidcOrganization): AuthOrganization => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    imageUrl: '',
    membersCount: 0,
    maxAllowedMemberships: 0,
    reload,
  });

  const derive = (snapshot: OidcSnapshot) => {
    if (cachedFor === snapshot && derived) return derived;
    cachedFor = snapshot;
    const { person } = snapshot;
    const organizations = snapshot.organizations.map(toOrganization);
    const memberships: AuthMembership[] = organizations.map((organization) => ({ organization }));
    const active = organizations.find((o) => o.id === snapshot.activeOrgId) ?? null;
    let auth: AuthState;
    let user: UserState;
    if (!snapshot.isLoaded) {
      auth = { ...NOT_LOADED, getToken, signOut };
      user = { isLoaded: false, isSignedIn: undefined, user: undefined };
    } else if (person) {
      auth = {
        isLoaded: true,
        isSignedIn: true,
        userId: person.id,
        orgId: snapshot.activeOrgId,
        orgSlug: active?.slug ?? null,
        getToken,
        signOut,
      };
      const email = person.email ? { emailAddress: person.email } : null;
      const authUser: AuthUser = {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        fullName: person.fullName,
        username: person.username,
        imageUrl: person.imageUrl,
        primaryEmailAddress: email,
        emailAddresses: email ? [email] : [],
        reload,
      };
      user = { isLoaded: true, isSignedIn: true, user: authUser };
    } else {
      auth = { ...SIGNED_OUT, getToken, signOut };
      user = { isLoaded: true, isSignedIn: false, user: null };
    }
    derived = {
      auth,
      user,
      organization: { isLoaded: snapshot.isLoaded, organization: snapshot.isLoaded ? active : undefined },
      list: snapshot.isLoaded
        ? { isLoaded: true, setActive, userMemberships: { ...EMPTY_MEMBERSHIPS, data: memberships } }
        : { isLoaded: false, setActive: undefined, userMemberships: EMPTY_MEMBERSHIPS },
    };
    return derived;
  };

  const useSnapshot = () => derive(useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot));

  function OidcProvider({ children }: Readonly<{ children: ReactNode }>) {
    return <>{children}</>;
  }

  return {
    provider: 'oidc',
    Provider: OidcProvider,
    useAuth: () => useSnapshot().auth,
    useUser: () => useSnapshot().user,
    useOrganization: () => useSnapshot().organization,
    useOrganizationList: () => useSnapshot().list,
    getToken: () => session.getToken(),
    redirectToSignIn: (opts) => session.signIn(opts),
    completeSignIn: () => session.completeSignIn(),
    accountUrl: session.accountUrl,
  };
}
