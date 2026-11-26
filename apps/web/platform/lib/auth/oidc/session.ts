/**
 * The OIDC session behind the facade: one `oidc-client-ts` UserManager
 * (authorization code + PKCE, a public client) and a small store React reads
 * through `useSyncExternalStore`.
 *
 * Workspaces follow one of two models, chosen by `/config.json`'s
 * `auth.workspaceSource` (`claim`, the default, or `header`):
 *
 * **`claim`** (the EU edition on Zitadel; ADR SEC-012):
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
 *
 * The token only knows organization ids and generated domains. Names, slugs
 * and workspaces created since the token was issued come from WeldSuite's
 * own list (`workspaces.ts`), read once a person is signed in and kept in
 * storage so the next page load has them at once.
 *
 * **`header`** (WeldID in membership mode, plan `weldid-auth-server.md`):
 * WeldID's tokens name no workspace at all, so there is nothing to narrow and
 * only one token ever exists. The workspace list comes entirely from
 * WeldSuite's own directory (`workspaces.ts`); the active workspace is a
 * locally stored choice, switched with no provider round trip; and every
 * request to WeldSuite's own API origins is tagged `X-Weld-Workspace`
 * (`workspaces.id`) by `lib/api/workspace-header.ts`, installed only in this
 * mode.
 *
 * **Inside the desktop shell** (`options.browserSignIn`, either mode): the
 * session belongs to the desktop app's own native client (`desktopClientId`)
 * and this page never navigates to the provider. A sign-in opens the provider
 * in the system browser, which comes back to a loopback listener of the
 * shell (RFC 8252); this page then redeems the code itself
 * (`./browser-sign-in.ts`). Refresh is the usual refresh-token grant. Signing
 * out revokes the refresh token, forgets the session and opens the
 * provider's sign-out in the browser, where its session cookie lives.
 *
 * **Signing out** in a browser always names the one registered post-logout
 * URI, `<origin>/`: WeldID and Zitadel compare it exactly and answer any
 * other with an error page ("This app can't sign you in"). A sign-out that
 * should land elsewhere (`/auth/login`, back on an invitation) puts that path
 * in the request's `state`, which the provider sends back; `init` then goes
 * on to it before the shell renders.
 *
 * **Step-up** (ADR SEC-022): before a sensitive action the API may want a
 * fresh sign-in or second factor (`MFA_REQUIRED` / `REVERIFICATION_REQUIRED`).
 * `stepUp` signs the same person in again with `prompt=login` and, for a
 * second factor, `acr_values=mfa`: in a popup, so the page and
 * its unsaved input stay; through the system browser in the desktop shell;
 * and as a full redirect back to this page when the popup is blocked. The
 * popup comes back to the callback route, which hands the response to this
 * page (`completeSignIn`).
 */

import { OidcClient, User, UserManager, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';
import { getLocale } from '@weldsuite/i18n';
import type { OidcAuthConfig } from '@/lib/runtime-config';
import { parseWorkspacePath, workspacePath } from '@/lib/workspace-url';
import { sameOriginPath } from '../same-origin-path';
import { loadWorkspacesFromApi, type LoadWorkspaces, type WorkspaceDirectoryEntry } from './workspaces';
import { endProviderSession } from './sign-in-api';
import { BrowserSignInError, type BrowserSignIn } from './browser-sign-in';
import { StepUpError, type StepUpLevel } from './step-up-error';
import {
  activeOrganizationId,
  DEFAULT_OIDC_SCOPES as SHARED_DEFAULT_OIDC_SCOPES,
  DEFAULT_ORG_CLAIM,
  organizationsFromClaims,
  personFromClaims,
  scopeFor,
  ZITADEL_AUDIENCE_SCOPE,
  ZITADEL_ORG_ROLES_SCOPE,
  type Claims,
  type OidcOrganization,
  type OidcPerson,
} from './claims';

/** The redirect URI to register at the provider: an existing route, so no new page is needed. */
export const OIDC_CALLBACK_PATH = '/auth/sso-callback';
export const DEFAULT_OIDC_SCOPES = [...SHARED_DEFAULT_OIDC_SCOPES];
const MEMBERSHIPS_KEY = 'weldsuite:oidc:memberships';
const DIRECTORY_KEY = 'weldsuite:oidc:workspaces';
/** `workspaceSource: "header"` only: the locally chosen active workspace. */
const ACTIVE_WORKSPACE_KEY = 'weldsuite:oidc:activeWorkspace';
/** The step-up popup's window name: opened by `stepUp` itself, then reused by the UserManager. */
const STEP_UP_WINDOW = 'weldsuite-step-up';
const STEP_UP_WIDTH = 500;
const STEP_UP_HEIGHT = 640;

export type OidcSessionConfig = OidcAuthConfig & { clientId: string };

export interface OidcSnapshot {
  isLoaded: boolean;
  person: OidcPerson | null;
  organizations: readonly OidcOrganization[];
  activeOrgId: string | null;
  /** WeldSuite's workspace list is being read. */
  isLoadingWorkspaces: boolean;
}

interface SignInState {
  returnTo?: string;
  /** The workspace this token was requested for; absent = the full workspace list. */
  orgId?: string;
}

/** What a sign-out carries through the provider in `state`. */
interface SignOutState {
  /** The page to land on, a path on this origin. */
  returnTo: string;
}

/** The workspace list and the active one, as `publish` puts them in the snapshot. */
type PublishedWorkspaces = Pick<OidcSnapshot, 'activeOrgId'> & { organizations: OidcOrganization[] };

interface StoredMemberships {
  sub: string;
  organizations: OidcOrganization[];
}

interface StoredDirectory {
  sub: string;
  workspaces: WorkspaceDirectoryEntry[];
}

interface StoredActiveWorkspace {
  sub: string;
  id: string;
}

export interface OidcSessionOptions {
  /** The SPA origin; defaults to `window.location.origin`. */
  origin?: string;
  /** Storage for the session and the workspace list; defaults to `localStorage`. */
  storage?: Storage;
  /** Overrides for the UserManager (tests). */
  settings?: Partial<UserManagerSettings>;
  /** Reads WeldSuite's workspace list; defaults to `GET /api/workspaces`. */
  loadWorkspaces?: LoadWorkspaces;
  /**
   * The desktop shell's sign-in through the system browser
   * (`desktopBrowserSignIn()`, `lib/desktop-auth.ts`); the config's
   * `clientId` is then the desktop app's client. See the file comment.
   */
  browserSignIn?: BrowserSignIn;
}

/** What one authorization request asks for, whichever way it travels. */
interface AuthorizationRequest {
  state: SignInState;
  scope: string | undefined;
  prompt: string | undefined;
  ui_locales: string;
  /** Step-up: `mfa` to have the second factor confirmed too. */
  acr_values?: string;
  /** Step-up: the signed-in person's address, so the provider asks for that account. */
  login_hint?: string;
}

/** 128 random bits, hex: the desktop sign-in's `nonce`. */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeStorage(storage: Storage | undefined): Storage | undefined {
  if (storage) return storage;
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Where a person manages their password, 2FA and passkeys when the config
 * names no `accountUrl`: Zitadel's self-service page under the issuer, like
 * the other Zitadel defaults here. An empty `accountUrl` turns the link off
 * (TASK-1427: Settings › Security had no way to reach it).
 */
export function defaultAccountUrl(issuer: string): string | undefined {
  try {
    return new URL('/ui/console/users/me', issuer).toString();
  } catch {
    return undefined;
  }
}

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
}

/** The step-up popup, centred on this window; null when the browser blocked it. */
function openStepUpWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  const left = Math.max(0, window.screenX + (window.outerWidth - STEP_UP_WIDTH) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - STEP_UP_HEIGHT) / 2);
  const features = `popup,width=${STEP_UP_WIDTH},height=${STEP_UP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`;
  return window.open('', STEP_UP_WINDOW, features);
}

export class OidcSession {
  readonly manager: UserManager;
  readonly accountUrl: string | undefined;
  private readonly orgClaim: string;
  private readonly organizationScope: string;
  private readonly workspaceSource: 'claim' | 'header';
  private readonly baseScope: string;
  private readonly storage: Storage | undefined;
  private readonly origin: string;
  private readonly loadWorkspaces: LoadWorkspaces;
  /** WeldSuite's own sign-in screens: the backend holds the provider session in a cookie. */
  private readonly platformSignIn: boolean;
  /** The desktop shell's system browser and loopback listener, when this page runs in it. */
  private readonly browserSignIn: BrowserSignIn | null;
  /** The browser sign-in under way, by the shell's id. */
  private browserFlow: string | null = null;
  private client: OidcClient | null = null;
  private user: User | null = null;
  private snapshot: OidcSnapshot = {
    isLoaded: false,
    person: null,
    organizations: [],
    activeOrgId: null,
    isLoadingWorkspaces: false,
  };
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<User | null> | null = null;
  private initialised: Promise<void> | null = null;
  /** The person and active workspace the directory was last read for. */
  private directoryReadFor: string | null = null;
  private directoryReading: Promise<void> | null = null;

  constructor(config: OidcSessionConfig, options: OidcSessionOptions = {}) {
    this.origin = options.origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
    this.storage = safeStorage(options.storage);
    this.loadWorkspaces = options.loadWorkspaces ?? loadWorkspacesFromApi;
    this.orgClaim = config.orgClaim ?? DEFAULT_ORG_CLAIM;
    this.workspaceSource = config.workspaceSource ?? 'claim';
    // `null` (WeldID: no such scope) and absent (Zitadel's default template)
    // mean different things; `??` alone would treat them the same.
    this.organizationScope = config.organizationScope === undefined ? ZITADEL_ORG_ROLES_SCOPE : (config.organizationScope ?? '');
    const audienceScope = config.audienceScope === undefined ? ZITADEL_AUDIENCE_SCOPE : (config.audienceScope ?? '');
    const scopes = [...(config.scopes ?? DEFAULT_OIDC_SCOPES)];
    if (config.audience && audienceScope) scopes.push(scopeFor(audienceScope, { audience: config.audience }));
    this.baseScope = scopes.join(' ');
    // The Zitadel console default only where the provider is Zitadel: WeldID
    // (workspace from a header) has no such page.
    this.accountUrl =
      config.accountUrl ?? (this.workspaceSource === 'claim' ? defaultAccountUrl(config.issuer) : undefined);
    this.platformSignIn = config.signIn === 'platform';
    this.browserSignIn = options.browserSignIn ?? null;
    this.manager = new UserManager({
      authority: config.issuer,
      client_id: config.clientId,
      redirect_uri: `${this.origin}${OIDC_CALLBACK_PATH}`,
      // Step-up's popup comes back to the same registered route (`completeSignIn`).
      popup_redirect_uri: `${this.origin}${OIDC_CALLBACK_PATH}`,
      // The desktop app signs out in the system browser, which then shows the
      // provider's own page: its client registers no post-logout URI.
      post_logout_redirect_uri: this.browserSignIn ? undefined : `${this.origin}/`,
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
      // On its way to the page a sign-out asked for: stays unloaded, so the
      // shell renders nothing (and redirects nowhere) while the page leaves.
      if (await this.continueAfterSignOut()) return;
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
    const request: AuthorizationRequest = {
      state,
      scope: orgScope ? `${this.baseScope} ${orgScope}` : undefined,
      // OIDC "Initiating User Registration": Zitadel and Keycloak open their sign-up form.
      prompt: options.intent === 'sign-up' ? 'create' : undefined,
      // So WeldID's own sign-in pages render in the platform's current language.
      ui_locales: getLocale(),
    };
    if (this.browserSignIn) {
      await this.signInThroughBrowser(this.browserSignIn, request);
      return;
    }
    await this.manager.signinRedirect(request);
  }

  /** Whether sign-in happens in the system browser (the desktop shell). */
  get signsInThroughBrowser(): boolean {
    return this.browserSignIn !== null;
  }

  /** Stop waiting for the browser; the sign-in then rejects as cancelled. */
  cancelSignIn(): void {
    const id = this.browserFlow;
    if (id) void this.browserSignIn?.cancel(id).catch(() => undefined);
  }

  /**
   * The desktop shell: the authorization request (state, nonce, PKCE S256,
   * kept in oidc-client-ts's state store) opens in the system browser, which
   * comes back to the shell's loopback listener; this page then redeems the
   * code itself, so the verifier and the tokens never leave it. Resolves
   * once the session is stored and the page is on its way to `returnTo`;
   * rejects with `BrowserSignInError`.
   */
  private async signInThroughBrowser(browser: BrowserSignIn, request: AuthorizationRequest): Promise<void> {
    const flow = await browser.start().catch(() => {
      throw new BrowserSignInError('failed');
    });
    this.browserFlow = flow.id;
    try {
      const signinRequest = await this.oidcClient().createSigninRequest({
        ...request,
        request_type: 'si:r',
        redirect_uri: flow.redirectUri,
        nonce: randomNonce(),
      });
      const callbackUrl = await browser.authorize(flow.id, signinRequest.url);
      // Checks the state against the store, the nonce, and redeems the code
      // with the verifier at the loopback redirect URI.
      const returnTo = await this.completeSignIn(callbackUrl);
      if (typeof window !== 'undefined') window.location.assign(returnTo);
    } catch (err) {
      await browser.cancel(flow.id).catch(() => undefined);
      throw err instanceof BrowserSignInError ? err : new BrowserSignInError('failed');
    } finally {
      if (this.browserFlow === flow.id) this.browserFlow = null;
    }
  }

  /** The UserManager's settings and metadata, for requests it has no method for. */
  private oidcClient(): OidcClient {
    this.client ??= new OidcClient(this.manager.settings, this.manager.metadataService);
    return this.client;
  }

  /**
   * Finish the redirect on the callback route; resolves to the path to
   * continue on. In a step-up popup the response goes to the page that
   * opened it, which redeems it, and the popup closes itself.
   */
  async completeSignIn(url?: string): Promise<string> {
    const user = await this.manager.signinCallback(url);
    if (!user) return '/';
    const state = user.state as SignInState | undefined;
    if (!state?.orgId) this.rememberMemberships(user);
    this.setUser(user, true);
    return sameOriginPath(state?.returnTo);
  }

  /**
   * Step-up (ADR SEC-022): the signed-in person signs in again at the
   * provider, with their second factor for `second_factor`, so the API takes
   * a sensitive action. Call it straight from a click: the popup must open in
   * the user's gesture. Resolves once the new tokens are stored; rejects with
   * `StepUpError`. When the popup is blocked the page goes to the provider
   * and comes back here instead, and this never resolves.
   */
  async stepUp(level: StepUpLevel): Promise<void> {
    const previous = this.user;
    const request: AuthorizationRequest = {
      state: {
        returnTo: currentPath(),
        // `claim` mode: the token stays on its workspace (Zitadel, which
        // never asks for step-up; kept consistent all the same).
        orgId: this.workspaceSource === 'claim' ? (this.snapshot.activeOrgId ?? undefined) : undefined,
      },
      scope: previous?.scope,
      // A factor proven after this request. Not `max_age=0`: WeldID up to
      // 0.1.0-alpha.5 can never meet it (the proof is always a moment old)
      // and sends the person back to sign in again, round and round.
      prompt: 'login',
      acr_values: level === 'second_factor' ? 'mfa' : undefined,
      login_hint: typeof previous?.profile.email === 'string' ? previous.profile.email : undefined,
      ui_locales: getLocale(),
    };
    let user: User;
    if (this.browserSignIn) {
      user = await this.stepUpThroughBrowser(this.browserSignIn, request);
    } else {
      // Opened here, still inside the click, so a blocked popup is known now;
      // the UserManager then navigates this same window by its name.
      const popup = openStepUpWindow();
      if (!popup) {
        await this.manager.signinRedirect(request);
        return new Promise<never>(() => undefined);
      }
      try {
        user = await this.manager.signinPopup({
          ...request,
          popupWindowTarget: STEP_UP_WINDOW,
          popupAbortOnClose: true,
        });
      } catch (err) {
        if (!popup.closed) popup.close();
        throw new StepUpError(err instanceof Error && /closed/i.test(err.message) ? 'cancelled' : 'failed');
      }
    }
    if (previous && user.profile.sub !== previous.profile.sub) {
      // Someone else signed in: their session is the stored one now, so the
      // page starts over as them rather than acting on another account.
      if (typeof window !== 'undefined') window.location.assign('/');
      throw new StepUpError('other_account');
    }
  }

  /** `stepUp` in the desktop shell: the system browser, then back on this page without navigating. */
  private async stepUpThroughBrowser(browser: BrowserSignIn, request: AuthorizationRequest): Promise<User> {
    const flow = await browser.start().catch(() => {
      throw new StepUpError('failed');
    });
    this.browserFlow = flow.id;
    try {
      const signinRequest = await this.oidcClient().createSigninRequest({
        ...request,
        request_type: 'si:r',
        redirect_uri: flow.redirectUri,
        nonce: randomNonce(),
      });
      const callbackUrl = await browser.authorize(flow.id, signinRequest.url);
      const user = await this.manager.signinRedirectCallback(callbackUrl);
      this.setUser(user, true);
      return user;
    } catch (err) {
      await browser.cancel(flow.id).catch(() => undefined);
      throw new StepUpError(err instanceof BrowserSignInError && err.reason === 'cancelled' ? 'cancelled' : 'failed');
    } finally {
      if (this.browserFlow === flow.id) this.browserFlow = null;
    }
  }

  async signOut(redirectUrl?: string): Promise<void> {
    this.forgetMemberships();
    // The session the sign-in screens opened: without this the next visit to
    // `/auth/login` would sign the same person straight back in.
    if (this.platformSignIn) await endProviderSession();
    const returnTo = redirectUrl ? sameOriginPath(redirectUrl) : '/';
    const post = `${this.origin}${returnTo}`;
    if (this.browserSignIn) {
      await this.signOutThroughBrowser(this.browserSignIn, post);
      return;
    }
    try {
      // Back to the registered `<origin>/` only (the file comment); any other
      // page rides in `state` and `continueAfterSignOut` goes on to it.
      const state: SignOutState | undefined = returnTo === '/' ? undefined : { returnTo };
      await this.manager.signoutRedirect(state ? { state } : undefined);
    } catch {
      // No end-session endpoint: forget the session locally.
      await this.manager.removeUser();
      if (typeof window !== 'undefined') window.location.assign(post);
    }
  }

  /**
   * The provider's way back from `signOut`: `<origin>/?state=…`. A state this
   * page stored goes on to the path it carries (and leaves `/` without the
   * query either way); any other `state`, or none, is not a sign-out of ours.
   * True when the page is leaving.
   */
  private async continueAfterSignOut(): Promise<boolean> {
    if (typeof window === 'undefined' || this.browserSignIn) return false;
    const { href, pathname, search } = window.location;
    if (pathname !== '/' || !new URLSearchParams(search).has('state')) return false;
    // Reads and removes the stored state; throws when there is none to match.
    const response = await this.manager.signoutRedirectCallback(href).catch(() => null);
    if (!response) return false;
    const state = response.userState as SignOutState | undefined;
    window.location.replace(sameOriginPath(state?.returnTo));
    return true;
  }

  /**
   * The desktop shell: the app's own grant ends here (its refresh token
   * revoked, the session forgotten), and the provider's sign-out opens in the
   * system browser, where its session cookie lives. That request names the
   * client only, never an `id_token_hint`: no token in a URL the browser keeps
   * in its history. The provider then asks before ending the browser's
   * session (WeldID's confirmation page); the app is signed out either way.
   */
  private async signOutThroughBrowser(browser: BrowserSignIn, post: string): Promise<void> {
    await this.manager.revokeTokens(['refresh_token']).catch(() => undefined);
    await this.manager.removeUser().catch(() => undefined);
    try {
      const request = await this.oidcClient().createSignoutRequest({ client_id: this.manager.settings.client_id });
      await browser.openExternal(request.url);
    } catch {
      // No end-session endpoint, or no browser: the session is forgotten here.
    }
    if (typeof window !== 'undefined') window.location.assign(post);
  }

  /**
   * Activate or switch workspace. `header`: a local choice only, like
   * Clerk's in-place switch, `returnTo` ignored; the caller reloads if it
   * must. `claim`: a token requested for it (see the file comment), coming
   * back to `returnTo`, or else to `returnPathFor(orgId)`.
   */
  async setActiveOrganization(orgId: string | null, returnTo?: string): Promise<void> {
    if (!orgId || orgId === this.snapshot.activeOrgId) return;
    if (this.workspaceSource === 'header') {
      const sub = this.snapshot.person?.id;
      if (!sub) return;
      this.rememberActiveWorkspace(sub, orgId);
      this.publish(this.snapshot.isLoaded);
      return;
    }
    if (!this.organizationScope) return;
    // In the desktop shell this is a trip through the system browser, which
    // the person may cancel: they then stay on the workspace they had.
    await this.signIn({ returnTo: returnTo ?? this.returnPathFor(orgId), orgId }).catch((err: unknown) => {
      if (!(err instanceof BrowserSignInError)) throw err;
    });
  }

  /** Re-read the profile (refresh with the refresh token). */
  async reload(): Promise<void> {
    await this.refresh();
  }

  /** Read WeldSuite's workspace list again (after creating a workspace server-side). */
  async reloadWorkspaces(): Promise<void> {
    const person = this.snapshot.person;
    if (!person) return;
    this.directoryReadFor = null;
    this.readDirectory(person.id, this.directoryOrgKey());
    this.publish(this.snapshot.isLoaded);
    await this.directoryReading;
  }

  /**
   * The workspace the directory read is keyed to: `header` mode has one
   * token for every workspace, so the read never depends on which is active.
   */
  private directoryOrgKey(): string | null {
    return this.workspaceSource === 'header' ? null : this.snapshot.activeOrgId;
  }

  /**
   * Where to come back after switching to `orgId`: this page, unless its URL
   * names another workspace. That page belongs to the workspace it names,
   * which the new token may not even list (the "Workspace not found" screen
   * after creating one), so the switch lands on the new workspace's home.
   */
  private returnPathFor(orgId: string): string {
    const here = currentPath();
    const named = typeof window === 'undefined' ? null : parseWorkspacePath(window.location.pathname);
    if (!named) return here;
    const target = this.snapshot.organizations.find((o) => o.id === orgId);
    const namesTarget =
      named.ref === orgId || (!!target?.slug && target.slug.toLowerCase() === named.ref.toLowerCase());
    return namesTarget ? here : workspacePath(target?.slug || orgId, '/');
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
      this.storage?.removeItem(DIRECTORY_KEY);
      this.storage?.removeItem(ACTIVE_WORKSPACE_KEY);
    } catch {
      // Nothing stored.
    }
  }

  /** `header` mode: the locally chosen active workspace, for this person. */
  private storedActiveWorkspace(sub: string): string | null {
    try {
      const raw = this.storage?.getItem(ACTIVE_WORKSPACE_KEY);
      const parsed = raw ? (JSON.parse(raw) as StoredActiveWorkspace) : null;
      return parsed?.sub === sub ? parsed.id : null;
    } catch {
      return null;
    }
  }

  private rememberActiveWorkspace(sub: string, id: string): void {
    try {
      this.storage?.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify({ sub, id } satisfies StoredActiveWorkspace));
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }

  /** WeldSuite's workspace list from the last read, for this person. */
  private storedDirectory(sub: string): WorkspaceDirectoryEntry[] {
    try {
      const raw = this.storage?.getItem(DIRECTORY_KEY);
      const parsed = raw ? (JSON.parse(raw) as StoredDirectory) : null;
      return parsed?.sub === sub && Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    } catch {
      return [];
    }
  }

  /**
   * What a successful read said, an empty list included: the person belongs
   * to no workspace (the backend answers an error, never `[]`, when its own
   * read fails, and a failed read never gets here).
   */
  private rememberDirectory(sub: string, workspaces: WorkspaceDirectoryEntry[]): void {
    try {
      this.storage?.setItem(DIRECTORY_KEY, JSON.stringify({ sub, workspaces } satisfies StoredDirectory));
    } catch {
      // Storage blocked: names come back on the next read.
    }
  }

  /**
   * Read the list once per person and active workspace (a token without a
   * workspace may be refused; the next one is asked again). Failures keep
   * what is stored.
   */
  private readDirectory(sub: string, activeOrgId: string | null): void {
    const key = `${sub}|${activeOrgId ?? ''}`;
    if (this.directoryReadFor === key) return;
    this.directoryReadFor = key;
    const reading = (async () => {
      const token = await this.getToken().catch(() => null);
      const workspaces = token ? await this.loadWorkspaces(token).catch(() => null) : null;
      if (workspaces && this.snapshot.person?.id === sub) this.rememberDirectory(sub, workspaces);
    })();
    this.directoryReading = reading;
    void reading.finally(() => {
      if (this.directoryReading !== reading) return;
      this.directoryReading = null;
      this.publish(this.snapshot.isLoaded);
    });
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

  /**
   * Header mode (WeldID): the token names no workspace, so the list and the
   * active choice are WeldSuite's own, never the claims.
   */
  private headerWorkspaces(sub: string, loaded: boolean): PublishedWorkspaces {
    const organizations = this.storedDirectory(sub).map(({ id, name, slug }) => ({ id, name, slug }));
    let activeOrgId = this.storedActiveWorkspace(sub);
    // One workspace: nothing to choose, same as the claim mode's auto-narrow.
    if (!activeOrgId && organizations.length === 1) activeOrgId = organizations[0]!.id;
    if (loaded) this.readDirectory(sub, null);
    return { organizations, activeOrgId };
  }

  /** Claim mode: the token names the active workspace and some of the list. */
  private claimWorkspaces(sub: string, claims: Claims, loaded: boolean): PublishedWorkspaces {
    const activeOrgId = activeOrganizationId(claims, this.orgClaim);
    // The stored list, plus whatever this token names (a narrowed token names one).
    const merged = new Map(this.storedMemberships(sub).map((o) => [o.id, o]));
    for (const org of organizationsFromClaims(claims, this.orgClaim)) if (!merged.has(org.id)) merged.set(org.id, org);
    // WeldSuite's name and slug over the provider's domain; workspaces the
    // token can't name yet (created since it was issued) join the list.
    for (const { id, name, slug } of this.storedDirectory(sub)) merged.set(id, { id, name, slug });
    if (loaded) this.readDirectory(sub, activeOrgId);
    return { organizations: [...merged.values()], activeOrgId };
  }

  private publish(loaded: boolean): void {
    const claims = (this.user?.profile ?? {}) as Claims;
    const person = this.user ? personFromClaims(claims) : null;
    let workspaces: PublishedWorkspaces = { organizations: [], activeOrgId: null };
    if (person) {
      workspaces =
        this.workspaceSource === 'header'
          ? this.headerWorkspaces(person.id, loaded)
          : this.claimWorkspaces(person.id, claims, loaded);
    }
    const { organizations, activeOrgId } = workspaces;
    this.snapshot = {
      isLoaded: loaded,
      person,
      organizations,
      activeOrgId,
      isLoadingWorkspaces: this.directoryReading !== null,
    };
    for (const listener of this.listeners) listener();
  }
}
