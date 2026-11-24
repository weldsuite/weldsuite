/**
 * The service worker's logic (ADR PASS-009): the only part of the extension
 * that holds tokens or calls the API. `index.ts` wires it to `chrome.*`; the
 * browser APIs it needs come in through `WorkerEnv`.
 *
 * MV3 stops an idle worker after about thirty seconds, so nothing here may
 * live only in memory: the server and settings are in `chrome.storage.local`,
 * the access token, open menus and pending saves in `chrome.storage.session`.
 */

import type {
  WeldPassItem,
  WeldPassItemInput,
  WeldPassPasswordsApi,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { hostOf, itemInputSchema } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import type { OidcMobileSession } from '@weldsuite/mobile-platform/oidc-session';
import { createPasswordsApi } from '../lib/api';
import { evaluateFill, pageContext } from '../lib/fill-policy';
import type {
  ExtensionState,
  FieldContext,
  FrameCommand,
  FrameResult,
  MenuContext,
  MenuItem,
  MenuOutcome,
  PromptContext,
  PromptOutcome,
  SignInResult,
} from '../lib/protocol';
import {
  inspectServer,
  profilePatterns,
  serverLabel,
  type DefaultServer,
  type ProfileResult,
  type ServerProblem,
  type ServerProfile,
} from '../lib/server';
import { isListed, mergeSettings, readSettings, SETTINGS_KEY, withHost, type Settings } from '../lib/settings';
import { pageUrlForSaving } from '../lib/urls';
import { AuthFlowError, createSession, type AuthPlatform } from './auth';
import { decideCapture, SaveQueue, type MemoryStore } from './save-queue';
import type { SenderKind } from './senders';
import type { KeyValueStore } from './stores';

export interface WorkerEnv extends AuthPlatform {
  defaultServer: DefaultServer;
  /** `chrome.storage.session`: memory only. */
  memory: MemoryStore;
  /** Every key in `memory` (`chrome.storage.session.get(null)`), to clean up a closed tab. */
  memoryKeys: () => Promise<string[]>;
  hasPermission: (patterns: string[]) => Promise<boolean>;
  removePermission: (patterns: string[]) => Promise<void>;
  /** Push to one frame; rejects when that document is gone. */
  sendToFrame: (
    tabId: number,
    command: FrameCommand,
    target: { frameId: number; documentId?: string },
  ) => Promise<FrameResult | undefined>;
  /** Tell open extension pages that the state changed. */
  broadcast: () => void;
  randomId: () => string;
  now?: () => number;
}

const SERVER_KEY = 'weldpass:server';
/** A cached `/config.json` judgement is read again after this long. */
const PROFILE_MAX_AGE_MS = 6 * 60 * 60_000;
const REGISTRATION_TTL_MS = 10 * 60_000;
/** How long after a submit the top frame is told to look for the save bar (a login that didn't navigate). */
const PROMPT_POKE_DELAY_MS = 1200;

interface StoredServer {
  origin: string;
  profile: ServerProfile | null;
  checkedAt: number;
}

interface MenuRegistration {
  tabId: number;
  frameId: number;
  documentId?: string;
  /** The frame's URL when the menu opened. */
  url: string;
  origin: string;
  field: FieldContext;
  topOrigin: string | null;
  at: number;
}

interface PromptRegistration {
  tabId: number;
  frameId: number;
  documentId?: string;
  at: number;
}

const menuKey = (nonce: string) => `weldpass:menu:${nonce}`;
const promptKey = (nonce: string) => `weldpass:prompt:${nonce}`;

/** A failure the worker reports to the caller by code (it crosses the message channel as data). */
export class WorkerError extends Error {
  constructor(
    readonly code: 'signed-out' | 'no-workspace' | 'no-server' | 'not-found' | 'invalid',
    message = code,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

type Content = Extract<SenderKind, { kind: 'content' }>;

export class WeldPassWorker {
  readonly queue: SaveQueue;
  private readonly now: () => number;
  private initialised: Promise<void> | null = null;
  private stored: StoredServer | null = null;
  private problem: ServerProblem | 'no-permission' | null = null;
  private missingPatterns: string[] = [];
  private session: OidcMobileSession | null = null;
  private sessionFor: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private api: WeldPassPasswordsApi | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly env: WorkerEnv) {
    this.now = env.now ?? Date.now;
    this.queue = new SaveQueue(env.memory, this.now);
  }

  // ── server and session ──────────────────────────────────────────────────

  init(): Promise<void> {
    this.initialised ??= (async () => {
      const raw = await this.env.local.getItem(SERVER_KEY);
      this.stored = parseStoredServer(raw) ?? { origin: this.env.defaultServer.origin, profile: null, checkedAt: 0 };
      if (this.stored.profile) {
        await this.useProfile(this.stored.profile);
        if (this.now() - this.stored.checkedAt > PROFILE_MAX_AGE_MS) void this.refreshServer();
      } else {
        await this.refreshServer();
      }
    })();
    return this.initialised;
  }

  private get origin(): string {
    return this.stored?.origin ?? this.env.defaultServer.origin;
  }

  /** Read the server's `/config.json` again and take what it says. */
  refreshServer(): Promise<void> {
    this.refreshing ??= (async () => {
      const result = await inspectServer(this.origin, this.env.fetchImpl);
      if (!result.ok) {
        // A server that was fine keeps working on its cached profile while it
        // is briefly unreachable; anything else is a problem to show.
        if (!(result.problem === 'unreachable' && this.stored?.profile)) {
          this.problem = result.problem;
          this.broadcastSoon();
        }
        return;
      }
      this.stored = { origin: this.origin, profile: result.profile, checkedAt: this.now() };
      await this.env.local.setItem(SERVER_KEY, JSON.stringify(this.stored));
      await this.useProfile(result.profile);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async useProfile(profile: ServerProfile): Promise<void> {
    const patterns = profilePatterns(profile);
    const granted = await this.env.hasPermission(patterns).catch(() => false);
    if (!granted) {
      const missing: string[] = [];
      for (const pattern of patterns) {
        if (!(await this.env.hasPermission([pattern]).catch(() => false))) missing.push(pattern);
      }
      this.problem = 'no-permission';
      this.missingPatterns = missing;
    } else {
      this.problem = null;
      this.missingPatterns = [];
    }

    // One session per issuer and client: a server whose sign-in changed starts over.
    const identity = `${profile.origin}|${profile.issuer}|${profile.clientId}`;
    if (this.sessionFor !== identity) {
      this.unsubscribe?.();
      this.session = createSession(profile, this.env);
      this.sessionFor = identity;
      this.unsubscribe = this.session.subscribe(() => this.broadcastSoon());
      const session = this.session;
      this.api = createPasswordsApi({
        apiOrigin: profile.apiOrigin,
        getToken: () => session.getToken(),
        getWorkspaceId: () =>
          profile.workspaceSource === 'header' ? session.getSnapshot().activeOrgId : null,
      });
      await session.init();
    }
    this.broadcastSoon();
  }

  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcastSoon(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.env.broadcast();
    }, 50);
  }

  /** Host access was granted or taken away: judge the current server again. */
  async permissionsChanged(): Promise<void> {
    await this.init();
    if (this.stored?.profile) await this.useProfile(this.stored.profile);
  }

  async state(): Promise<ExtensionState> {
    await this.init();
    if (this.stored && this.now() - this.stored.checkedAt > PROFILE_MAX_AGE_MS) void this.refreshServer();
    const snapshot = this.session?.getSnapshot();
    const profile = this.stored?.profile ?? null;
    return {
      server: {
        origin: this.origin,
        label: serverLabel(this.origin),
        problem: this.problem ?? (profile ? null : 'unreachable'),
        missingPatterns: this.missingPatterns,
        accountUrl: profile?.accountUrl ?? null,
        isDefault: this.origin === this.env.defaultServer.origin,
      },
      loaded: snapshot?.isLoaded ?? false,
      person: snapshot?.person
        ? { name: snapshot.person.fullName ?? snapshot.person.username, email: snapshot.person.email }
        : null,
      workspaces: (snapshot?.organizations ?? []).map((org) => ({ id: org.id, name: org.name })),
      activeWorkspaceId: snapshot?.activeOrgId ?? null,
      loadingWorkspaces: snapshot?.isLoadingWorkspaces ?? false,
    };
  }

  async signIn(): Promise<SignInResult> {
    await this.init();
    if (!this.session || this.problem) {
      await this.refreshServer();
      if (!this.session || this.problem) return { ok: false, reason: 'server' };
    }
    try {
      const result = await this.session.signIn({ locale: uiLanguage() });
      return result === 'signed-in' ? { ok: true } : { ok: false, reason: 'cancelled' };
    } catch (error) {
      if (error instanceof AuthFlowError) return { ok: false, reason: 'unreachable', message: error.message };
      const code = (error as { code?: string }).code;
      if (code === 'unreachable' || code === 'network') return { ok: false, reason: 'unreachable' };
      return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : undefined };
    }
  }

  /** Sign out, revoke the refresh token, and drop every open menu, bar and pending login. */
  async signOut(): Promise<ExtensionState> {
    await this.init();
    await this.session?.signOut();
    await this.closeEverything();
    return this.state();
  }

  async setWorkspace(workspaceId: string): Promise<ExtensionState> {
    await this.init();
    const snapshot = this.session?.getSnapshot();
    if (!snapshot?.organizations.some((org) => org.id === workspaceId)) throw new WorkerError('not-found');
    await this.session?.setActiveOrganization(workspaceId);
    return this.state();
  }

  async inspect(origin: string): Promise<{ ok: true; issuer: string; patterns: string[] } | { ok: false; problem: ServerProblem }> {
    const result: ProfileResult = await inspectServer(origin, this.env.fetchImpl);
    if (!result.ok) return result;
    return { ok: true, issuer: result.profile.issuer, patterns: profilePatterns(result.profile) };
  }

  /** Switch server (`null`: back to the build's default). The old session is signed out. */
  async setServer(
    requested: string | null,
  ): Promise<{ ok: true; state: ExtensionState } | { ok: false; problem: ServerProblem | 'no-permission' }> {
    await this.init();
    const origin = requested ?? this.env.defaultServer.origin;
    const result = await inspectServer(origin, this.env.fetchImpl);
    if (!result.ok) return result;
    if (!(await this.env.hasPermission(profilePatterns(result.profile)).catch(() => false))) {
      return { ok: false, problem: 'no-permission' };
    }

    const previous = this.stored?.profile;
    if (origin !== this.origin) {
      await this.session?.signOut();
      await this.closeEverything();
    }
    this.stored = { origin, profile: result.profile, checkedAt: this.now() };
    await this.env.local.setItem(SERVER_KEY, JSON.stringify(this.stored));
    await this.useProfile(result.profile);

    // Give back the host access of a self-hosted server that is no longer used.
    if (previous && previous.origin !== origin) {
      const keep = new Set([
        ...profilePatterns(result.profile),
        ...profilePatterns({
          origin: this.env.defaultServer.origin,
          apiOrigin: this.env.defaultServer.origin,
          issuer: this.env.defaultServer.issuer,
        }),
      ]);
      const unused = profilePatterns(previous).filter((pattern) => !keep.has(pattern));
      if (unused.length > 0) await this.env.removePermission(unused).catch(() => undefined);
    }
    return { ok: true, state: await this.state() };
  }

  // ── settings ────────────────────────────────────────────────────────────

  async settings(): Promise<Settings> {
    const raw = await this.env.local.getItem(SETTINGS_KEY);
    try {
      return readSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return readSettings(null);
    }
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = mergeSettings(await this.settings(), patch);
    await this.env.local.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  // ── the API, for the popup ──────────────────────────────────────────────

  /** The API, once someone is signed in and (header mode) has picked a workspace. */
  async passwords(): Promise<WeldPassPasswordsApi> {
    await this.init();
    const snapshot = this.session?.getSnapshot();
    if (!this.api || !this.stored?.profile || this.problem) throw new WorkerError('no-server');
    if (!snapshot?.person) throw new WorkerError('signed-out');
    if (this.stored.profile.workspaceSource === 'header' && !snapshot.activeOrgId) {
      throw new WorkerError('no-workspace');
    }
    return this.api;
  }

  private async ready(): Promise<boolean> {
    try {
      await this.passwords();
      return true;
    } catch {
      return false;
    }
  }

  // ── inline menus (2B) ───────────────────────────────────────────────────

  /** Whether a content script should show inline icons in its frame. */
  async hello(sender: Content): Promise<{ inline: boolean }> {
    const page = pageContext(sender.url);
    if (!page.ok) return { inline: false };
    const settings = await this.settings();
    if (!settings.inlineMenus || isListed(page.host, settings.neverMenuHosts)) return { inline: false };
    return { inline: await this.ready() };
  }

  async menuOpen(sender: Content, field: FieldContext, topOrigin: string | null): Promise<{ nonce: string } | null> {
    if (!(await this.hello(sender)).inline) return null;
    const page = pageContext(sender.url);
    if (!page.ok) return null;
    const nonce = this.env.randomId();
    const registration: MenuRegistration = {
      tabId: sender.tabId,
      frameId: sender.frameId,
      documentId: sender.documentId,
      url: sender.url,
      origin: page.origin,
      field: { kind: field.kind, hasPassword: Boolean(field.hasPassword), hasUsername: Boolean(field.hasUsername) },
      topOrigin: typeof topOrigin === 'string' ? topOrigin : null,
      at: this.now(),
    };
    await this.env.memory.set(menuKey(nonce), registration);
    return { nonce };
  }

  private async menu(tabId: number, nonce: string): Promise<MenuRegistration | null> {
    if (typeof nonce !== 'string' || nonce.length < 16) return null;
    const registration = await this.env.memory.get<MenuRegistration>(menuKey(nonce));
    if (!registration || registration.tabId !== tabId) return null;
    if (this.now() - registration.at > REGISTRATION_TTL_MS) {
      await this.env.memory.remove(menuKey(nonce));
      return null;
    }
    return registration;
  }

  /** The saved logins that may go into this frame: matched by the server, and allowed by the policy here. */
  private async fillable(api: WeldPassPasswordsApi, registration: MenuRegistration): Promise<WeldPassItem[]> {
    const matches = (await api.matchItems(registration.origin)).data;
    return matches.filter((item) => item.type === 'login' && evaluateFill(item, registration.url).ok);
  }

  async menuInit(tabId: number, nonce: string): Promise<MenuContext | null> {
    const registration = await this.menu(tabId, nonce);
    if (!registration) return null;
    const api = await this.passwords();
    const crossOrigin = registration.topOrigin !== null && registration.topOrigin !== registration.origin;
    const base = { kind: registration.field.kind, frameOrigin: registration.origin, crossOrigin };
    if (!pageContext(registration.url).ok) return { ...base, items: [], blocked: true };
    if (registration.field.kind === 'new-password') return { ...base, items: [], blocked: false };

    let items = await this.fillable(api, registration);
    if (registration.field.kind === 'one-time-code') items = items.filter((item) => item.hasTotp);
    return { ...base, blocked: false, items: items.map(menuItem) };
  }

  /**
   * Fill the picked login into the frame the menu belongs to. The policy is
   * judged before the reveal (on the item as matched) and after it (on the
   * item as revealed), and the frame judges it once more before filling.
   */
  async menuFill(tabId: number, nonce: string, itemId: string, vaultId: string): Promise<MenuOutcome> {
    const registration = await this.menu(tabId, nonce);
    if (!registration) return { ok: false, reason: 'expired' };
    const api = await this.passwords();
    const item = (await this.fillable(api, registration)).find((m) => m.id === itemId && m.vaultId === vaultId);
    if (!item?.host) return { ok: false, reason: 'refused' };

    let username = item.subtitle ?? '';
    let password: string | null = null;
    if (registration.field.hasPassword) {
      const revealed = (await api.revealItem(item.vaultId, item.id)).data;
      if (revealed.type !== 'login' || !('password' in revealed.fields)) return { ok: false, reason: 'refused' };
      if (!revealed.host || !evaluateFill(revealed, registration.url).ok) return { ok: false, reason: 'refused' };
      username = revealed.fields.username;
      password = revealed.fields.password;
    } else if (!username) {
      return { ok: false, reason: 'no-fields' };
    }

    const result = await this.toFrame(registration, {
      type: 'fill:login',
      nonce,
      expectedOrigin: registration.origin,
      itemHost: item.host,
      username,
      password,
    });
    if (result.ok && password !== null) {
      const host = hostOf(registration.origin);
      if (host) {
        await this.queue.recordFill(
          tabId,
          { host, item: { id: item.id, vaultId: item.vaultId, title: item.title }, username },
          password,
        );
      }
    }
    if (result.ok) await this.menuClose(tabId, nonce);
    return result;
  }

  /** A 2FA code, minted by the server (PASS-007), into the frame's one-time-code field. */
  async menuTotp(tabId: number, nonce: string, itemId: string, vaultId: string): Promise<MenuOutcome> {
    const registration = await this.menu(tabId, nonce);
    if (!registration) return { ok: false, reason: 'expired' };
    const api = await this.passwords();
    const item = (await this.fillable(api, registration)).find((m) => m.id === itemId && m.vaultId === vaultId);
    if (!item?.host || !item.hasTotp) return { ok: false, reason: 'refused' };
    const { code } = (await api.generateTotp(item.vaultId, item.id)).data;
    const result = await this.toFrame(registration, {
      type: 'fill:otp',
      nonce,
      expectedOrigin: registration.origin,
      itemHost: item.host,
      code,
    });
    if (result.ok) await this.menuClose(tabId, nonce);
    return result;
  }

  /** A password the menu generated, into the frame's new-password field(s). */
  async menuGenerated(tabId: number, nonce: string, password: string): Promise<MenuOutcome> {
    const registration = await this.menu(tabId, nonce);
    if (!registration) return { ok: false, reason: 'expired' };
    if (registration.field.kind !== 'new-password' || !pageContext(registration.url).ok) {
      return { ok: false, reason: 'refused' };
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return { ok: false, reason: 'refused' };
    }
    const result = await this.toFrame(registration, {
      type: 'fill:new-password',
      nonce,
      expectedOrigin: registration.origin,
      password,
    });
    if (result.ok) await this.menuClose(tabId, nonce);
    return result;
  }

  async menuClose(tabId: number, nonce: string): Promise<null> {
    const registration = await this.menu(tabId, nonce);
    if (!registration) return null;
    await this.env.memory.remove(menuKey(nonce));
    await this.env
      .sendToFrame(registration.tabId, { type: 'menu:remove', nonce }, frameTarget(registration))
      .catch(() => undefined);
    return null;
  }

  /** The content script closed its menu (Escape, a click elsewhere, typing). */
  async menuClosed(sender: Content, nonce: string): Promise<null> {
    const registration = await this.menu(sender.tabId, nonce);
    if (registration && registration.frameId === sender.frameId) await this.env.memory.remove(menuKey(nonce));
    return null;
  }

  private async toFrame(
    registration: MenuRegistration,
    command: FrameCommand,
  ): Promise<{ ok: true } | { ok: false; reason: 'page-changed' | 'no-fields' | 'refused' }> {
    let result: FrameResult | undefined;
    try {
      result = await this.env.sendToFrame(registration.tabId, command, frameTarget(registration));
    } catch {
      // The document is gone (navigated, closed): nothing was filled.
      return { ok: false, reason: 'page-changed' };
    }
    if (result?.status === 'filled') return { ok: true };
    if (result?.status === 'origin-mismatch') return { ok: false, reason: 'page-changed' };
    if (result?.status === 'refused') return { ok: false, reason: 'refused' };
    return { ok: false, reason: 'no-fields' };
  }

  // ── save and update prompts (2C) ────────────────────────────────────────

  /**
   * A login form was submitted in a frame. Decide whether to ask, and keep
   * the login in memory for the next page of this tab. Nothing is answered to
   * the content script: it keeps nothing and learns nothing.
   */
  async capture(sender: Content, username: string, password: string): Promise<null> {
    if (typeof username !== 'string' || typeof password !== 'string') return null;
    if (username.length > 255 || password.length > 4096) return null;
    const page = pageContext(sender.url);
    if (!page.ok) return null;
    const settings = await this.settings();
    if (!settings.savePrompts || isListed(page.host, settings.neverSaveHosts)) return null;
    if (!(await this.ready())) return null;
    const api = await this.passwords();

    const name = username.trim();
    if (!password) {
      // The first step of a two-step login: remember who, for the next step.
      if (name) await this.queue.rememberUsername(sender.tabId, page.host, name);
      return null;
    }
    const user = name || (await this.queue.username(sender.tabId, page.host)) || '';

    const decision = decideCapture({
      username: user,
      passwordHash: await this.queue.hash(password),
      fill: await this.queue.fillRecord(sender.tabId),
      host: page.host,
      matches: await api.matchItems(page.origin).then((res) => res.data, () => []),
    });
    if (decision.action === 'ignore') return null;

    let kind: 'save' | 'update' = decision.action === 'save' ? 'save' : 'update';
    const item = decision.action === 'save' ? null : decision.item;
    if (decision.action === 'compare') {
      // One reveal to tell a typed-in, unchanged password from a new one.
      const revealed = await api.revealItem(decision.item.vaultId, decision.item.id).catch(() => null);
      const stored = revealed && 'password' in revealed.data.fields ? revealed.data.fields.password : null;
      if (stored === password) return null;
      kind = 'update';
    }

    await this.queue.put(sender.tabId, {
      origin: page.origin,
      host: page.host,
      url: pageUrlForSaving(sender.url) ?? page.origin,
      username: user,
      password,
      kind,
      item,
    });
    // A sign-in that doesn't navigate: the bar shows on this page.
    setTimeout(() => {
      void this.env.sendToFrame(sender.tabId, { type: 'prompt:poke' }, { frameId: 0 }).catch(() => undefined);
    }, PROMPT_POKE_DELAY_MS);
    return null;
  }

  /** The top frame of a tab, after load or a poke: show the bar if a save is pending. */
  async promptCheck(sender: Content): Promise<{ nonce: string } | null> {
    if (sender.frameId !== 0) return null;
    const pending = await this.queue.get(sender.tabId);
    if (!pending) return null;
    // One bar per document.
    for (const [nonce, registration] of await this.promptRegistrations(sender.tabId)) {
      if (registration.documentId && registration.documentId === sender.documentId) return null;
      await this.env.memory.remove(promptKey(nonce));
    }
    const nonce = this.env.randomId();
    await this.env.memory.set(promptKey(nonce), {
      tabId: sender.tabId,
      frameId: sender.frameId,
      documentId: sender.documentId,
      at: this.now(),
    } satisfies PromptRegistration);
    return { nonce };
  }

  private async promptRegistrations(tabId: number): Promise<Array<[string, PromptRegistration]>> {
    const keys = (await this.env.memoryKeys()).filter((key) => key.startsWith('weldpass:prompt:'));
    const found: Array<[string, PromptRegistration]> = [];
    for (const key of keys) {
      const registration = await this.env.memory.get<PromptRegistration>(key);
      if (registration?.tabId === tabId) found.push([key.slice('weldpass:prompt:'.length), registration]);
    }
    return found;
  }

  private async prompt(tabId: number, nonce: string): Promise<PromptRegistration | null> {
    if (typeof nonce !== 'string' || nonce.length < 16) return null;
    const registration = await this.env.memory.get<PromptRegistration>(promptKey(nonce));
    if (!registration || registration.tabId !== tabId) return null;
    return registration;
  }

  async promptInit(tabId: number, nonce: string): Promise<PromptContext | null> {
    if (!(await this.prompt(tabId, nonce))) return null;
    const pending = await this.queue.get(tabId);
    if (!pending) return null;
    const vaults =
      pending.kind === 'save'
        ? (await (await this.passwords()).listVaults()).data
            .filter((vault) => vault.role === 'editor' || vault.role === 'manager')
            .map((vault) => ({ id: vault.id, name: vault.name, personal: vault.kind === 'personal' }))
        : [];
    return {
      kind: pending.kind,
      host: pending.host,
      username: pending.username,
      itemTitle: pending.item?.title ?? null,
      vaults,
    };
  }

  async promptSave(tabId: number, nonce: string, vaultId: string): Promise<PromptOutcome> {
    if (!(await this.prompt(tabId, nonce))) return { ok: false, reason: 'expired' };
    const pending = await this.queue.get(tabId);
    if (!pending || pending.kind !== 'save') return { ok: false, reason: 'expired' };
    const api = await this.passwords();
    const input = itemInputSchema.safeParse({
      type: 'login',
      title: pending.host,
      url: pending.url,
      fields: { username: pending.username, password: pending.password, totp: '', notes: '' },
    });
    if (!input.success) return { ok: false, reason: 'error' };
    await api.createItem(vaultId, input.data);
    await this.queue.take(tabId);
    await this.promptClose(tabId, nonce);
    return { ok: true };
  }

  async promptUpdate(tabId: number, nonce: string): Promise<PromptOutcome> {
    if (!(await this.prompt(tabId, nonce))) return { ok: false, reason: 'expired' };
    const pending = await this.queue.get(tabId);
    if (!pending?.item || pending.kind !== 'update') return { ok: false, reason: 'expired' };
    const api = await this.passwords();
    // The API replaces an item whole: read it, change the password, send it all back.
    const current = (await api.revealItem(pending.item.vaultId, pending.item.id)).data;
    if (current.type !== 'login' || !('password' in current.fields)) return { ok: false, reason: 'error' };
    const input: WeldPassItemInput = {
      type: 'login',
      title: current.title,
      url: current.url,
      fields: {
        ...current.fields,
        username: current.fields.username || pending.username,
        password: pending.password,
      },
    };
    await api.updateItem(pending.item.vaultId, pending.item.id, input);
    await this.queue.take(tabId);
    await this.promptClose(tabId, nonce);
    return { ok: true };
  }

  async promptNever(tabId: number, nonce: string): Promise<PromptOutcome> {
    if (!(await this.prompt(tabId, nonce))) return { ok: false, reason: 'expired' };
    const pending = await this.queue.take(tabId);
    if (pending) {
      const settings = await this.settings();
      await this.setSettings({ neverSaveHosts: withHost(settings.neverSaveHosts, pending.host) });
    }
    await this.promptClose(tabId, nonce);
    return { ok: true };
  }

  async promptDismiss(tabId: number, nonce: string): Promise<PromptOutcome> {
    if (!(await this.prompt(tabId, nonce))) return { ok: false, reason: 'expired' };
    await this.queue.take(tabId);
    await this.promptClose(tabId, nonce);
    return { ok: true };
  }

  private async promptClose(tabId: number, nonce: string): Promise<void> {
    const registration = await this.prompt(tabId, nonce);
    await this.env.memory.remove(promptKey(nonce));
    if (registration) {
      await this.env
        .sendToFrame(tabId, { type: 'prompt:remove', nonce }, frameTarget(registration))
        .catch(() => undefined);
    }
  }

  async promptClosed(sender: Content, nonce: string): Promise<null> {
    const registration = await this.prompt(sender.tabId, nonce);
    if (registration) await this.env.memory.remove(promptKey(nonce));
    return null;
  }

  // ── housekeeping ────────────────────────────────────────────────────────

  async tabClosed(tabId: number): Promise<void> {
    await this.queue.clearTab(tabId);
    for (const key of await this.env.memoryKeys()) {
      if (!key.startsWith('weldpass:menu:') && !key.startsWith('weldpass:prompt:')) continue;
      const registration = await this.env.memory.get<{ tabId?: number }>(key);
      if (registration?.tabId === tabId) await this.env.memory.remove(key);
    }
  }

  /** Signing out or switching server: no menu, bar or pending login survives. */
  private async closeEverything(): Promise<void> {
    for (const key of await this.env.memoryKeys()) {
      if (key.startsWith('weldpass:menu:') || key.startsWith('weldpass:prompt:')) await this.env.memory.remove(key);
      if (/^weldpass:(pending|filled|username):/.test(key)) await this.env.memory.remove(key);
    }
  }
}

function menuItem(item: WeldPassItem): MenuItem {
  return {
    id: item.id,
    vaultId: item.vaultId,
    title: item.title,
    username: item.subtitle,
    host: item.host,
    hasTotp: item.hasTotp,
  };
}

function frameTarget(registration: { frameId: number; documentId?: string }): { frameId: number; documentId?: string } {
  return registration.documentId
    ? { frameId: registration.frameId, documentId: registration.documentId }
    : { frameId: registration.frameId };
}

function parseStoredServer(raw: string | null): StoredServer | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.origin !== 'string') return null;
    return {
      origin: record.origin,
      profile: typeof record.profile === 'object' && record.profile !== null ? (record.profile as ServerProfile) : null,
      checkedAt: typeof record.checkedAt === 'number' ? record.checkedAt : 0,
    };
  } catch {
    return null;
  }
}

function uiLanguage(): string | undefined {
  try {
    return typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getUILanguage().split('-')[0] : undefined;
  } catch {
    return undefined;
  }
}

export type { KeyValueStore };
