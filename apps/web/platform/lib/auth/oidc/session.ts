/**
 * The OIDC session behind the facade: one `oidc-client-ts` UserManager
 * (authorization code + PKCE, a public client) and a small store React reads
 * through `useSyncExternalStore`.
 *
 * Workspaces follow ADR SEC-012 as the EU edition runs it on Zitadel:
 *
 * 1. Sign-in asks for no organization. The token's roles claim then lists
 *    every organization that granted the person a role on the project: their
 *    workspace list, kept in storage for later tokens.
 * 2. With one workspace, that token already names it (the backend reads the
 *    org claim the same way, `claims.ts`). With several it names none, the
 *    app shell activates one, and:
 * 3. Activating or switching a workspace is a new token request with
 *    `urn:zitadel:iam:org:roles:id:<orgId>` (`organizationScope`), which
 *    narrows the roles claim to that organization. The provider's own session
 *    makes it a round trip without a form.
 *
 * Every request also carries `urn:zitadel:iam:org:project:id:<audience>:aud`
 * (`audienceScope`) so the project is in `aud`, which the backend checks
 * (`OIDC_AUDIENCE`). Refreshes reuse the granted scopes, so a refreshed token
 * stays on its workspace.
 */

import { User, UserManager, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';
import type { OidcAuthConfig } from '@/lib/runtime-config';
import {
  activeOrganizationId,
  DEFAULT_ORG_CLAIM,
  organizationsFromClaims,
  personFromClaims,
  scopeFor,
  ZITADEL_AUDIENCE_SCOPE,
  ZITADEL_ORG_ROLES_SCOPE,
  ZITADEL_ROLES_SCOPE,
  type Claims,
  type OidcOrganization,
  type OidcPerson,
} from './claims';

/** The redirect URI to register at the provider: an existing route, so no new page is needed. */
export const OIDC_CALLBACK_PATH = '/auth/sso-callback';
export const DEFAULT_OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access', ZITADEL_ROLES_SCOPE];
const MEMBERSHIPS_KEY = 'weldsuite:oidc:memberships';

export type OidcSessionConfig = OidcAuthConfig & { clientId: string };

export interface OidcSnapshot {
  isLoaded: boolean;
  person: OidcPerson | null;
  organizations: readonly OidcOrganization[];
  activeOrgId: string | null;
}

interface SignInState {
  returnTo?: string;
  /** The workspace this token was requested for; absent = the full workspace list. */
  orgId?: string;
}

interface StoredMemberships {
  sub: string;
  organizations: OidcOrganization[];
}

export interface OidcSessionOptions {
  /** The SPA origin; defaults to `window.location.origin`. */
  origin?: string;
  /** Storage for the session and the workspace list; defaults to `localStorage`. */
  storage?: Storage;
  /** Overrides for the UserManager (tests). */
  settings?: Partial<UserManagerSettings>;
}

function safeStorage(storage: Storage | undefined): Storage | undefined {
  if (storage) return storage;
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Only paths on this origin are valid places to return to after sign-in. */
function sameOriginPath(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
}

export class OidcSession {
  readonly manager: UserManager;
  readonly accountUrl: string | undefined;
  private readonly orgClaim: string;
  private readonly organizationScope: string;
  private readonly baseScope: string;
  private readonly storage: Storage | undefined;
  private readonly origin: string;
  private user: User | null = null;
  private snapshot: OidcSnapshot = { isLoaded: false, person: null, organizations: [], activeOrgId: null };
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<User | null> | null = null;
  private initialised: Promise<void> | null = null;

  constructor(config: OidcSessionConfig, options: OidcSessionOptions = {}) {
    this.origin = options.origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
    this.storage = safeStorage(options.storage);
    this.orgClaim = config.orgClaim ?? DEFAULT_ORG_CLAIM;
    this.organizationScope = config.organizationScope ?? ZITADEL_ORG_ROLES_SCOPE;
    const audienceScope = config.audienceScope ?? ZITADEL_AUDIENCE_SCOPE;
    const scopes = [...(config.scopes ?? DEFAULT_OIDC_SCOPES)];
    if (config.audience && audienceScope) scopes.push(scopeFor(audienceScope, { audience: config.audience }));
    this.baseScope = scopes.join(' ');
    this.accountUrl = config.accountUrl;
    this.manager = new UserManager({
      authority: config.issuer,
      client_id: config.clientId,
      redirect_uri: `${this.origin}${OIDC_CALLBACK_PATH}`,
      post_logout_redirect_uri: `${this.origin}/`,
      response_type: 'code',
      scope: this.baseScope,
      // Shared by every tab, like Clerk's session.
      userStore: this.storage ? new WebStorageStateStore({ store: this.storage }) : undefined,
      automaticSilentRenew: true,
      ...options.settings,
    });
    this.manager.events.addUserLoaded((user) => this.setUser(user));
    this.manager.events.addUserUnloaded(() => this.setUser(null));
    this.manager.events.addUserSignedOut(() => void this.manager.removeUser());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OidcSnapshot => this.snapshot;

  /** Read the stored session once; an expired one is refreshed or dropped. */
  init(): Promise<void> {
    this.initialised ??= (async () => {
      let user = await this.manager.getUser().catch(() => null);
      if (user?.expired) user = await this.refresh();
      this.setUser(user, true);
    })();
    return this.initialised;
  }

  /** The access token, refreshed when it has expired. Null when signed out. */
  async getToken(): Promise<string | null> {
    await this.init();
    let user = this.user;
    if (user?.expired) user = await this.refresh();
    return user?.access_token ?? null;
  }

  /**
   * Off to the provider. With `orgId` the token is requested for that
   * workspace (`organizationScope`); without, it lists all of them.
   */
  async signIn(options: { intent?: 'sign-in' | 'sign-up'; returnTo?: string; orgId?: string } = {}): Promise<void> {
    const state: SignInState = { returnTo: sameOriginPath(options.returnTo), orgId: options.orgId };
    const orgScope = options.orgId && this.organizationScope ? scopeFor(this.organizationScope, { orgId: options.orgId }) : '';
    await this.manager.signinRedirect({
      state,
      scope: orgScope ? `${this.baseScope} ${orgScope}` : undefined,
      // OIDC "Initiating User Registration": Zitadel and Keycloak open their sign-up form.
      prompt: options.intent === 'sign-up' ? 'create' : undefined,
    });
  }

  /** Finish the redirect on the callback route; resolves to the path to continue on. */
  async completeSignIn(url?: string): Promise<string> {
    const user = await this.manager.signinRedirectCallback(url);
    const state = user.state as SignInState | undefined;
    if (!state?.orgId) this.rememberMemberships(user);
    this.setUser(user, true);
    return sameOriginPath(state?.returnTo);
  }

  async signOut(redirectUrl?: string): Promise<void> {
    this.forgetMemberships();
    const post = redirectUrl ? `${this.origin}${sameOriginPath(redirectUrl)}` : undefined;
    try {
      await this.manager.signoutRedirect(post ? { post_logout_redirect_uri: post } : undefined);
    } catch {
      // No end-session endpoint: forget the session locally.
      await this.manager.removeUser();
      if (typeof window !== 'undefined') window.location.assign(post ?? `${this.origin}/`);
    }
  }

  /** Activate or switch workspace: a token requested for it (see the file comment). */
  async setActiveOrganization(orgId: string | null): Promise<void> {
    if (!orgId || orgId === this.snapshot.activeOrgId || !this.organizationScope) return;
    await this.signIn({ returnTo: currentPath(), orgId });
  }

  /** Re-read the profile (refresh with the refresh token). */
  async reload(): Promise<void> {
    await this.refresh();
  }

  private refresh(): Promise<User | null> {
    this.refreshing ??= this.manager
      .signinSilent()
      .catch(async () => {
        await this.manager.removeUser().catch(() => undefined);
        return null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private rememberMemberships(user: User): void {
    const claims = user.profile as Claims;
    const stored: StoredMemberships = {
      sub: user.profile.sub,
      organizations: organizationsFromClaims(claims, this.orgClaim),
    };
    try {
      this.storage?.setItem(MEMBERSHIPS_KEY, JSON.stringify(stored));
    } catch {
      // Storage blocked: the list lasts for this page only.
    }
  }

  private forgetMemberships(): void {
    try {
      this.storage?.removeItem(MEMBERSHIPS_KEY);
    } catch {
      // Nothing stored.
    }
  }

  /** The workspace list from the last unscoped token, for this person. */
  private storedMemberships(sub: string): OidcOrganization[] {
    try {
      const raw = this.storage?.getItem(MEMBERSHIPS_KEY);
      const parsed = raw ? (JSON.parse(raw) as StoredMemberships) : null;
      return parsed?.sub === sub && Array.isArray(parsed.organizations) ? parsed.organizations : [];
    } catch {
      return [];
    }
  }

  private setUser(user: User | null, loaded = this.snapshot.isLoaded): void {
    // An expired session still counts while a refresh token can renew it.
    const usable = user !== null && (!user.expired || Boolean(user.refresh_token));
    this.user = usable ? user : null;
    this.publish(loaded);
  }

  private publish(loaded: boolean): void {
    const claims = (this.user?.profile ?? {}) as Claims;
    const person = this.user ? personFromClaims(claims) : null;
    let organizations: OidcOrganization[] = [];
    if (person) {
      // The stored list, plus whatever this token names (a narrowed token names one).
      const merged = new Map(this.storedMemberships(person.id).map((o) => [o.id, o]));
      for (const org of organizationsFromClaims(claims, this.orgClaim)) if (!merged.has(org.id)) merged.set(org.id, org);
      organizations = [...merged.values()];
    }
    this.snapshot = {
      isLoaded: loaded,
      person,
      organizations,
      activeOrgId: person ? activeOrganizationId(claims, this.orgClaim) : null,
    };
    for (const listener of this.listeners) listener();
  }
}
