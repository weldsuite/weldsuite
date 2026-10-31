/**
 * The widget's visitor session: who this browser is to helpdesk-widget-api.
 *
 * `POST /api/visitor` hands out a visitor token, kept per widget in
 * localStorage, which every other call sends as a Bearer. On each page load
 * the session is opened again with, in order of preference:
 *
 *  - the identity token the host page passed through the SDK (a verified
 *    visitor: name and email come from the token, not from what is typed);
 *  - the visitor token this browser already holds (the same anonymous
 *    visitor; a token for a signed-in visitor sent without an identity
 *    token means the user signed out on the site, and the API answers with a
 *    fresh anonymous visitor);
 *  - once, the visitor id older widget versions generated in the browser.
 *
 * Embedded, the first session waits briefly for the SDK's weld:init, so a
 * signed-in visitor isn't first created as an anonymous one. A widget that
 * only talks to signed-in users answers IDENTITY_REQUIRED: the session then
 * sits in `identity-required` until the page signs someone in.
 */

import {
  createVisitorApi,
  isIdentityInvalidError,
  isIdentityRequiredError,
  widgetApi,
  WidgetApiError,
  type SessionVisitor,
  type VisitorApi,
  type VisitorAuth,
  type VisitorSessionRequest,
} from './api/client';
import type { DeskVisitorSession } from '@weldsuite/app-api-client/schemas/desk-portal';
import {
  clearCustomerProfile,
  clearLegacyVisitorId,
  clearVisitorToken,
  getLegacyVisitorId,
  getVisitorToken,
  saveVisitorToken,
} from './utils/customer-storage';
import { getHostAuth, onHostAuth, waitForHostInit, type HostAuthEvent } from './sdk-bridge';

export type SessionStatus = 'starting' | 'ready' | 'identity-required';

export interface SessionSnapshot {
  status: SessionStatus;
  /** The visitor the current token belongs to; null while a session is being opened. */
  visitor: SessionVisitor | null;
}

export class IdentityRequiredError extends Error {
  constructor() {
    super('This chat is only open to signed-in users');
    this.name = 'IdentityRequiredError';
  }
}

export class VisitorSession implements VisitorAuth {
  readonly api: VisitorApi;
  private token: string | null;
  /** From the host page, in memory only: the page passes it again on every load. */
  private identityToken: string | null = null;
  private hostRead = false;
  /** Unverified name / email from the page, stored once the session is open. */
  private hostTyped: { name?: string; email?: string } | null = null;
  private opening: Promise<string> | null = null;
  /** Bumped by every sign-in / sign-out, so an older session request can't win. */
  private generation = 0;
  private snapshot: SessionSnapshot = { status: 'starting', visitor: null };
  private readonly listeners = new Set<() => void>();

  constructor(readonly widgetId: string) {
    this.token = getVisitorToken(widgetId);
    this.api = createVisitorApi(this);
    onHostAuth((event) => this.onHostAuth(event));
  }

  // ---- store (useSyncExternalStore) --------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private update(next: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  // ---- VisitorAuth ----------------------------------------------------------

  getToken(): Promise<string> {
    if (this.snapshot.status === 'identity-required') return Promise.reject(new IdentityRequiredError());
    if (this.token && this.snapshot.status === 'ready') return Promise.resolve(this.token);
    return this.open();
  }

  renew(stale: string): Promise<string> {
    if (this.token && this.token !== stale && this.snapshot.status === 'ready') return Promise.resolve(this.token);
    if (this.token === stale) {
      this.token = null;
      clearVisitorToken(this.widgetId);
    }
    return this.open();
  }

  markIdentityRequired(): void {
    if (this.snapshot.status !== 'identity-required') this.update({ status: 'identity-required', visitor: null });
  }

  // ---- name / email the visitor (or the page, unverified) gave -----------------

  /** Store a typed name / email. A verified visitor's name and email come from the identity token, so they stay. */
  async identifyTyped(input: { name?: string; email?: string }): Promise<void> {
    await this.getToken();
    if (this.snapshot.visitor?.verified) return;
    const before = this.snapshot.visitor?.id;
    const { visitor } = await this.api.identify({
      name: input.name?.trim() || undefined,
      email: input.email?.trim() || undefined,
    });
    if (this.snapshot.visitor && this.snapshot.visitor.id === before && visitor.id === before) {
      this.update({ visitor });
    }
  }

  // ---- opening a session ------------------------------------------------------

  private open(): Promise<string> {
    if (this.opening) return this.opening;
    const opening = this.runOpen().finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  /** Throw away the current session and open a new one (sign-in, sign-out). */
  private restart() {
    this.generation++;
    this.opening = null;
    this.update({ status: 'starting', visitor: null });
    void this.open().catch(() => {});
  }

  /** Take what the host page passed with `weld:init`: an identity token, or unverified name / email. */
  private readHostAuth(): void {
    const host = getHostAuth();
    this.identityToken = host?.identityToken ?? null;
    // Name / email the page passed without a token (SDK auth config, an early identify()).
    if (!this.identityToken && (host?.name || host?.email)) this.hostTyped = { name: host.name, email: host.email };
  }

  /** The proof to open the session with: identity token, else this browser's token, else (once) the legacy id. */
  private sessionRequest(): { body: VisitorSessionRequest; legacyId: string | null } {
    if (this.identityToken) return { body: { identityToken: this.identityToken }, legacyId: null };
    if (this.token) return { body: { visitorToken: this.token }, legacyId: null };
    const legacyId = getLegacyVisitorId();
    return { body: legacyId ? { legacyVisitorId: legacyId } : {}, legacyId };
  }

  /**
   * A failed session start. True when it is worth one more try as a guest
   * (the identity token was refused); throws otherwise.
   */
  private retryAfter(err: unknown, body: VisitorSessionRequest): boolean {
    const tokenRefused = isIdentityInvalidError(err) || (err instanceof WidgetApiError && err.status === 400);
    if (body.identityToken && tokenRefused) {
      // Expired, not signed with this widget's secret, or the widget has no
      // identity verification set up: carry on as a guest.
      console.warn('[WeldDesk] The identity token was refused; continuing as an anonymous visitor.');
      this.identityToken = null;
      return true;
    }
    if (isIdentityRequiredError(err)) {
      this.markIdentityRequired();
      throw new IdentityRequiredError();
    }
    throw err;
  }

  private accept(session: DeskVisitorSession, legacyId: string | null): string {
    this.token = session.visitorToken;
    saveVisitorToken(this.widgetId, session.visitorToken);
    // Swapped (or refused for good): the old id never goes out again.
    if (legacyId) clearLegacyVisitorId();
    this.update({ status: 'ready', visitor: session.visitor });
    const typed = this.hostTyped;
    this.hostTyped = null;
    if (typed) void this.identifyTyped(typed).catch(() => {});
    return session.visitorToken;
  }

  private async runOpen(): Promise<string> {
    const generation = this.generation;
    if (!this.hostRead) {
      await waitForHostInit();
      if (generation !== this.generation) return this.open();
      this.hostRead = true;
      this.readHostAuth();
    }

    for (;;) {
      const { body, legacyId } = this.sessionRequest();
      let session: DeskVisitorSession;
      try {
        session = await widgetApi.startSession(this.widgetId, body);
      } catch (err) {
        if (generation !== this.generation) return this.open();
        if (this.retryAfter(err, body)) continue;
        throw err;
      }
      if (generation !== this.generation) return this.open();
      return this.accept(session, legacyId);
    }
  }

  // ---- the host page signs someone in or out ---------------------------------

  private onHostAuth(event: HostAuthEvent) {
    this.hostRead = true;
    if (event.type === 'logout') {
      this.identityToken = null;
      this.token = null;
      clearVisitorToken(this.widgetId);
      clearCustomerProfile(this.widgetId);
      this.restart();
      return;
    }

    const { identityToken, name, email } = event.auth;
    if (identityToken) {
      const same =
        identityToken === this.identityToken && this.snapshot.status === 'ready' && this.snapshot.visitor?.verified;
      if (same) return;
      this.identityToken = identityToken;
      this.restart();
      return;
    }
    if (name || email) void this.identifyTyped({ name, email }).catch(() => {});
  }
}

const sessions = new Map<string, VisitorSession>();

/** One session per widget id for the life of the page. */
export function getVisitorSession(widgetId: string): VisitorSession {
  let session = sessions.get(widgetId);
  if (!session) {
    session = new VisitorSession(widgetId);
    sessions.set(widgetId, session);
  }
  return session;
}
