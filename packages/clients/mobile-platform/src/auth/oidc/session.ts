/**
 * The OIDC session behind the mobile facade (EU on Zitadel, self-hosted with
 * any OIDC provider): authorization code + PKCE in the system browser sheet,
 * a public native client (`OIDC_MOBILE_CLIENT_ID`), refresh tokens in the
 * secure store. Pure apart from the injected dependencies, so it is tested
 * without React Native.
 *
 * Workspaces follow ADR SEC-012 as the platform's `oidc/session.ts` does:
 *
 * 1. Sign-in asks for no organization. The token then lists every
 *    organization that granted the person a role: their workspace list.
 * 2. A token for one workspace is a new authorization request with the
 *    organization scope (`urn:zitadel:iam:org:roles:id:<orgId>`). The
 *    provider's session cookie in the browser sheet means no form, but the
 *    sheet still opens.
 * 3. To keep that to the first visit, one refresh token is kept per
 *    workspace (the last six used). Switching back to a workspace already
 *    used refreshes its token without a browser.
 *
 * The access token lives in memory only. After a restart the active
 * workspace's refresh token gets a new one on the first API call; offline,
 * the person stays signed in with the cached profile until a refresh is
 * refused (`invalid_grant`).
 */

import {
  activeOrganizationId,
  DEFAULT_OIDC_SCOPES,
  DEFAULT_ORG_CLAIM,
  organizationsFromClaims,
  personFromClaims,
  scopeFor,
  ZITADEL_AUDIENCE_SCOPE,
  ZITADEL_ORG_ROLES_SCOPE,
  type Claims,
  type OidcOrganization,
  type OidcPerson,
} from '@weldsuite/app-api-client/auth/oidc-claims';
import type { KeyValueStore } from '../../runtime/state';
import {
  base64ToBase64Url,
  base64UrlFromBytes,
  decodeJwtPayload,
  formBody,
  queryParams,
  withQuery,
} from './encoding';
import type { HostedSignInResult } from '../types';
import { trimTrailing } from '../../text';

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface AuthSessionResult {
  type: string;
  url?: string;
}

export interface OidcSessionDeps {
  fetchImpl: typeof fetch;
  secureStore: SecureStoreLike;
  /** Non-secret cache: the person's name and workspace list. */
  cacheStore: KeyValueStore;
  /** Open the browser sheet at `url`; resolves with the redirect to `redirectUri`. */
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
  randomBytes: (size: number) => Uint8Array;
  /** SHA-256 of a string, standard base64. */
  sha256Base64: (input: string) => Promise<string>;
  now?: () => number;
}

export interface OidcSessionConfig {
  issuer: string;
  clientId: string;
  /** `<app scheme>://sso-callback`. */
  redirectUri: string;
  audience?: string | null;
  orgClaim?: string | null;
  scopes?: readonly string[];
  audienceScope?: string;
  organizationScope?: string;
  /** One stored session per server: a key-safe form of its origin. */
  storageId: string;
}

export interface OidcSnapshot {
  isLoaded: boolean;
  person: OidcPerson | null;
  organizations: readonly OidcOrganization[];
  activeOrgId: string | null;
}

/** A sign-in that failed for a reason worth showing (not a cancelled sheet). */
export class OidcSignInError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OidcSignInError';
  }
}

class TokenError extends Error {
  constructor(
    readonly kind: 'invalid-grant' | 'network' | 'server',
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface StoredTokens {
  v: 1;
  sub: string;
  /** The active workspace's organization id, or `*` for the unscoped token. */
  active: string;
  /** Refresh token per workspace key; `refresh` is '' when none was issued. */
  tokens: Record<string, { refresh: string; at: number }>;
}

interface CachedProfile {
  sub: string;
  person: OidcPerson;
  organizations: OidcOrganization[];
}

interface AccessToken {
  token: string;
  expiresAt: number;
  key: string;
}

export const UNSCOPED = '*';
const MAX_TOKENS = 6;
const EXPIRY_MARGIN_MS = 30_000;
const DEFAULT_EXPIRES_IN_S = 300;
const REVOKE_TIMEOUT_MS = 3000;

/** Keys may only hold letters, digits, `.`, `-` and `_` (expo-secure-store). */
export function storageIdFor(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OidcMobileSession {
  private readonly orgClaim: string;
  private readonly organizationScope: string;
  private readonly baseScope: string;
  private readonly secureKey: string;
  private readonly profileKey: string;
  private readonly now: () => number;
  private stored: StoredTokens | null = null;
  private profile: CachedProfile | null = null;
  private access: AccessToken | null = null;
  private discovery: Promise<Discovery> | null = null;
  private initialised: Promise<void> | null = null;
  private readonly refreshing = new Map<string, Promise<string | null>>();
  private snapshot: OidcSnapshot = { isLoaded: false, person: null, organizations: [], activeOrgId: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly config: OidcSessionConfig,
    private readonly deps: OidcSessionDeps,
  ) {
    this.orgClaim = config.orgClaim ?? DEFAULT_ORG_CLAIM;
    this.organizationScope = config.organizationScope ?? ZITADEL_ORG_ROLES_SCOPE;
    const audienceScope = config.audienceScope ?? ZITADEL_AUDIENCE_SCOPE;
    const scopes = [...(config.scopes ?? DEFAULT_OIDC_SCOPES)];
    if (config.audience && audienceScope) scopes.push(scopeFor(audienceScope, { audience: config.audience }));
    this.baseScope = scopes.join(' ');
    this.secureKey = `weldsuite.oidc.${config.storageId}`;
    this.profileKey = `weldsuite:oidc-profile:${config.storageId}`;
    this.now = deps.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OidcSnapshot => this.snapshot;

  /** Read the stored session once. Never waits for the network. */
  init(): Promise<void> {
    this.initialised ??= (async () => {
      const [stored, profile] = await Promise.all([this.readStored(), this.readProfile()]);
      if (stored && stored.sub === profile?.sub && stored.tokens[stored.active]) {
        this.stored = stored;
        this.profile = profile;
      } else if (stored || profile) {
        await this.clearStorage();
      }
      this.publish(true);
    })();
    return this.initialised;
  }

  /** The access token for the active workspace, refreshed when needed. Null when signed out. */
  async getToken(): Promise<string | null> {
    await this.init();
    const key = this.stored?.active;
    if (!key) return null;
    const access = this.access;
    if (access?.key === key && access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return access.token;
    return this.refreshKey(key);
  }

  /** Sign in (or up) in the browser sheet. With `orgId`, for that workspace. */
  async signIn(options: { intent?: 'sign-in' | 'sign-up'; orgId?: string } = {}): Promise<HostedSignInResult> {
    await this.init();
    let discovery: Discovery;
    try {
      discovery = await this.discover();
    } catch {
      throw new OidcSignInError('The sign-in server could not be reached', 'unreachable');
    }
    const verifier = base64UrlFromBytes(this.deps.randomBytes(32));
    const state = base64UrlFromBytes(this.deps.randomBytes(16));
    const nonce = base64UrlFromBytes(this.deps.randomBytes(16));
    const url = await this.authorizeUrl(discovery, options, { verifier, state, nonce });

    const result = await this.deps.openAuthSession(url, this.config.redirectUri);
    if (result.type !== 'success' || !result.url) return 'cancelled';
    const code = codeFromRedirect(result.url, state);
    if (code === null) return 'cancelled';

    const response = await this.exchangeCode(code, verifier);
    const idClaims = decodeJwtPayload(response.id_token);
    if (idClaims && typeof idClaims.nonce === 'string' && idClaims.nonce !== nonce) {
      throw new OidcSignInError('The sign-in response did not match the request', 'nonce_mismatch');
    }
    await this.acceptSignIn(response, options.orgId);
    return 'signed-in';
  }

  private async authorizeUrl(
    discovery: Discovery,
    options: { intent?: 'sign-in' | 'sign-up'; orgId?: string },
    pkce: { verifier: string; state: string; nonce: string },
  ): Promise<string> {
    const challenge = base64ToBase64Url(await this.deps.sha256Base64(pkce.verifier));
    const scope =
      options.orgId && this.organizationScope
        ? `${this.baseScope} ${scopeFor(this.organizationScope, { orgId: options.orgId })}`
        : this.baseScope;
    return withQuery(discovery.authorization_endpoint, {
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope,
      state: pkce.state,
      nonce: pkce.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // OIDC "Initiating User Registration": Zitadel and Keycloak open their sign-up form.
      prompt: options.intent === 'sign-up' ? 'create' : undefined,
    });
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    try {
      return await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: verifier,
      });
    } catch (error) {
      throw new OidcSignInError(
        error instanceof Error ? error.message : 'Sign-in failed',
        error instanceof TokenError ? error.kind : 'server',
      );
    }
  }

  /** Activate or switch workspace: its kept token, else a sign-in for it. */
  async setActiveOrganization(orgId: string | null): Promise<void> {
    await this.init();
    if (!orgId || !this.stored || orgId === this.snapshot.activeOrgId) return;
    if (this.stored.tokens[orgId]?.refresh) {
      const token = await this.refreshKey(orgId);
      if (token && this.stored) {
        this.stored.active = orgId;
        await this.persist();
        this.publish(true);
        return;
      }
    }
    if (!this.organizationScope) return;
    await this.signIn({ orgId });
  }

  /** Re-read the profile (a refresh returns a new ID token). */
  async reload(): Promise<void> {
    const key = this.stored?.active;
    if (key) await this.refreshKey(key);
  }

  /** Forget the session here and revoke its refresh tokens at the provider. */
  async signOut(): Promise<void> {
    await this.init();
    const refreshTokens = Object.values(this.stored?.tokens ?? {})
      .map((entry) => entry.refresh)
      .filter(Boolean);
    await this.forget();
    if (refreshTokens.length === 0) return;
    try {
      const discovery = await this.discover();
      const endpoint = discovery.revocation_endpoint;
      if (!endpoint) return;
      await Promise.all(refreshTokens.map((token) => this.revoke(endpoint, token)));
    } catch {
      // Offline: the tokens expire at the provider on their own.
    }
  }

  // ── tokens ────────────────────────────────────────────────────────────────

  private refreshKey(key: string): Promise<string | null> {
    const running = this.refreshing.get(key);
    if (running) return running;
    const promise = this.doRefresh(key).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, promise);
    return promise;
  }

  private async doRefresh(key: string): Promise<string | null> {
    const entry = this.stored?.tokens[key];
    if (!entry) return null;
    if (!entry.refresh) {
      // No refresh token was issued: the session ends with its access token.
      await this.dropKey(key);
      return null;
    }
    try {
      const response = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: entry.refresh });
      await this.acceptRefresh(response, key);
      return response.access_token;
    } catch (error) {
      if (error instanceof TokenError && error.kind === 'invalid-grant') await this.dropKey(key);
      return null;
    }
  }

  private async acceptSignIn(response: TokenResponse, requestedOrgId: string | undefined): Promise<void> {
    const claims = this.claimsOf(response);
    const person = personFromClaims(claims);
    if (!person) throw new OidcSignInError('The sign-in server returned no identity', 'no_identity');
    const named = organizationsFromClaims(claims, this.orgClaim);
    const tokenOrg = activeOrganizationId(claims, this.orgClaim);
    const key = requestedOrgId ? (tokenOrg ?? requestedOrgId) : (tokenOrg ?? UNSCOPED);

    const samePerson = this.stored?.sub === person.id;
    const previous = samePerson ? (this.profile?.organizations ?? []) : [];
    // An unscoped token lists every workspace; a narrowed one names one.
    const organizations = requestedOrgId ? mergeOrganizations(previous, named) : named;

    const stored: StoredTokens =
      samePerson && this.stored ? this.stored : { v: 1, sub: person.id, active: key, tokens: {} };
    stored.tokens[key] = { refresh: response.refresh_token ?? '', at: this.now() };
    stored.active = key;
    pruneTokens(stored);
    this.stored = stored;
    this.profile = { sub: person.id, person, organizations };
    this.access = this.accessFrom(response, key);
    await this.persist();
    this.publish(true);
  }

  private async acceptRefresh(response: TokenResponse, key: string): Promise<void> {
    const stored = this.stored;
    if (!stored) return;
    const entry = stored.tokens[key];
    if (entry) {
      if (response.refresh_token) entry.refresh = response.refresh_token;
      entry.at = this.now();
    }
    const claims = this.claimsOf(response);
    const person = personFromClaims(claims);
    if (person?.id === stored.sub && this.profile) {
      const named = organizationsFromClaims(claims, this.orgClaim);
      this.profile = {
        ...this.profile,
        person,
        organizations: key === UNSCOPED && named.length > 0 ? named : mergeOrganizations(this.profile.organizations, named),
      };
    }
    this.access = this.accessFrom(response, key);
    await this.persist();
    this.publish(true);
  }

  private async dropKey(key: string): Promise<void> {
    const stored = this.stored;
    if (!stored) return;
    delete stored.tokens[key];
    const remaining = Object.entries(stored.tokens).sort((a, b) => b[1].at - a[1].at);
    if (remaining.length === 0) {
      await this.forget();
      return;
    }
    if (stored.active === key) stored.active = remaining[0]![0];
    if (this.access?.key === key) this.access = null;
    await this.persist();
    this.publish(true);
  }

  private accessFrom(response: TokenResponse, key: string): AccessToken {
    const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : DEFAULT_EXPIRES_IN_S;
    return { token: response.access_token, expiresAt: this.now() + expiresIn * 1000, key };
  }

  /** ID token claims over access token claims: roles may be asserted in either. */
  private claimsOf(response: TokenResponse): Claims {
    return { ...decodeJwtPayload(response.access_token), ...decodeJwtPayload(response.id_token) };
  }

  // ── provider calls ────────────────────────────────────────────────────────

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = `${trimTrailing(this.config.issuer, '/')}/.well-known/openid-configuration`;
      const res = await this.deps.fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`discovery: ${res.status}`);
      const body: unknown = await res.json();
      if (
        !isRecord(body) ||
        typeof body.authorization_endpoint !== 'string' ||
        typeof body.token_endpoint !== 'string'
      ) {
        throw new Error('discovery: invalid document');
      }
      return {
        authorization_endpoint: body.authorization_endpoint,
        token_endpoint: body.token_endpoint,
        revocation_endpoint: typeof body.revocation_endpoint === 'string' ? body.revocation_endpoint : undefined,
      };
    })().catch((error: unknown) => {
      this.discovery = null;
      throw error;
    });
    return this.discovery;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    let discovery: Discovery;
    try {
      discovery = await this.discover();
    } catch {
      throw new TokenError('network', 'The sign-in server could not be reached');
    }
    let res: Response;
    try {
      res = await this.deps.fetchImpl(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: formBody({ ...params, client_id: this.config.clientId }),
      });
    } catch {
      throw new TokenError('network', 'The sign-in server could not be reached');
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const record = isRecord(body) ? body : {};
    if (!res.ok) {
      const code = typeof record.error === 'string' ? record.error : '';
      const kind = code === 'invalid_grant' || code === 'invalid_client' ? 'invalid-grant' : 'server';
      const description = typeof record.error_description === 'string' ? record.error_description : '';
      throw new TokenError(kind, description || code || `token endpoint: ${res.status}`);
    }
    if (typeof record.access_token !== 'string') throw new TokenError('server', 'No access token');
    return {
      access_token: record.access_token,
      refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
      id_token: typeof record.id_token === 'string' ? record.id_token : undefined,
      expires_in: typeof record.expires_in === 'number' ? record.expires_in : undefined,
    };
  }

  private async revoke(endpoint: string, token: string): Promise<void> {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS) : null;
    try {
      await this.deps.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ token, token_type_hint: 'refresh_token', client_id: this.config.clientId }),
        signal: controller?.signal,
      });
    } catch {
      // Best effort.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── storage ───────────────────────────────────────────────────────────────

  private async readStored(): Promise<StoredTokens | null> {
    try {
      const raw = await this.deps.secureStore.getItemAsync(this.secureKey);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.sub !== 'string' || typeof parsed.active !== 'string') {
        return null;
      }
      if (!isRecord(parsed.tokens)) return null;
      return parsed as unknown as StoredTokens;
    } catch {
      return null;
    }
  }

  private async readProfile(): Promise<CachedProfile | null> {
    try {
      const raw = await this.deps.cacheStore.getItem(this.profileKey);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.sub !== 'string' || !isRecord(parsed.person)) return null;
      if (!Array.isArray(parsed.organizations)) return null;
      return parsed as unknown as CachedProfile;
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    try {
      if (this.stored) await this.deps.secureStore.setItemAsync(this.secureKey, JSON.stringify(this.stored));
      if (this.profile) await this.deps.cacheStore.setItem(this.profileKey, JSON.stringify(this.profile));
    } catch {
      // The session lasts for this run only.
    }
  }

  private async clearStorage(): Promise<void> {
    await this.deps.secureStore.deleteItemAsync(this.secureKey).catch(() => undefined);
    await this.deps.cacheStore.removeItem(this.profileKey).catch(() => undefined);
  }

  private async forget(): Promise<void> {
    this.stored = null;
    this.profile = null;
    this.access = null;
    await this.clearStorage();
    this.publish(true);
  }

  private publish(loaded: boolean): void {
    const signedIn = Boolean(this.stored && this.profile);
    const active = this.stored?.active;
    this.snapshot = {
      isLoaded: loaded,
      person: signedIn ? (this.profile?.person ?? null) : null,
      organizations: signedIn ? (this.profile?.organizations ?? []) : [],
      activeOrgId: signedIn && active && active !== UNSCOPED ? active : null,
    };
    for (const listener of this.listeners) listener();
  }
}

/**
 * The authorization code from the redirect back to the app. Null when the
 * person declined (no reason given); throws on any other error or a forged
 * `state`.
 */
function codeFromRedirect(url: string, state: string): string | null {
  const params = queryParams(url);
  if (params.error) {
    if (params.error === 'access_denied' && !params.error_description) return null;
    throw new OidcSignInError(params.error_description || params.error, params.error);
  }
  if (!params.code || params.state !== state) {
    throw new OidcSignInError('The sign-in response did not match the request', 'state_mismatch');
  }
  return params.code;
}

/** `previous` plus any workspace `named` adds (a known name is kept: roles claims only carry domains). */
function mergeOrganizations(
  previous: readonly OidcOrganization[],
  named: readonly OidcOrganization[],
): OidcOrganization[] {
  const merged = new Map(previous.map((org) => [org.id, org]));
  for (const org of named) if (!merged.has(org.id)) merged.set(org.id, org);
  return [...merged.values()];
}

/** Keep the active token and the most recently used others, up to MAX_TOKENS. */
function pruneTokens(stored: StoredTokens): void {
  const entries = Object.entries(stored.tokens).sort((a, b) => b[1].at - a[1].at);
  if (entries.length <= MAX_TOKENS) return;
  const keep = new Set([stored.active, ...entries.slice(0, MAX_TOKENS - 1).map(([key]) => key)]);
  for (const [key] of entries) if (!keep.has(key)) delete stored.tokens[key];
}
