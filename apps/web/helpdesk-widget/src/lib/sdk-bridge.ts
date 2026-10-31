/**
 * Who the host page says the visitor is, from the SDK's postMessages
 * (packages/sdk/helpdesk-widget-sdk):
 *
 *   ← weld:init        {widgetId, iframeType, config, auth?: HostAuth}   on iframe load
 *   ← weld:auth:login  HostAuth (+ avatar, metadata)                     identify() / boot()
 *   ← weld:auth:logout {}                                                logout() / shutdown()
 *
 * `identityToken` is a JWT the customer's server signed with the widget's
 * identity secret; it reaches the widget only by postMessage, never in a URL.
 *
 * The listener is installed when this module loads, before React mounts:
 * the SDK posts weld:init from the iframe's onload, which can beat the first
 * effect, and the visitor session must not start before it knows.
 */

export interface HostAuth {
  identityToken?: string;
  userId?: string;
  email?: string;
  name?: string;
}

export type HostAuthEvent = { type: 'login'; auth: HostAuth } | { type: 'logout' };

const params = new URLSearchParams(globalThis.location?.search ?? '');

/** The SDK passes its page's origin; only messages from that origin are trusted. */
export const parentOrigin = params.get('parentOrigin') || '*';

function detectEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export const embedded = typeof window !== 'undefined' && detectEmbedded();

/** How long to wait for weld:init before starting an anonymous session anyway (old embeds never send one). */
const INIT_WAIT_MS = 2500;

let hostAuth: HostAuth | null = null;
let initReceived = !embedded;
/** A wait gave up on weld:init: a late one with a token must switch the session itself. */
let initWaitExpired = false;
const initWaiters = new Set<() => void>();
const listeners = new Set<(event: HostAuthEvent) => void>();

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function readAuth(value: unknown): HostAuth | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const auth: HostAuth = {
    identityToken: str(raw.identityToken, 4096),
    userId: str(raw.userId, 255),
    email: str(raw.email, 255),
    name: str(raw.name, 255),
  };
  return auth.identityToken || auth.userId || auth.email || auth.name ? auth : null;
}

function markInitReceived() {
  if (initReceived) return;
  initReceived = true;
  for (const resolve of initWaiters) resolve();
  initWaiters.clear();
}

function emit(event: HostAuthEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // one bad listener must not stop the others
    }
  }
}

function onMessage(event: MessageEvent) {
  if (event.source !== window.parent) return;
  if (parentOrigin !== '*' && event.origin !== parentOrigin) return;
  const data = event.data as { type?: unknown; payload?: unknown } | null;
  switch (data?.type) {
    case 'weld:init': {
      const payload = (data.payload ?? {}) as { auth?: unknown };
      // A repeated init (iframe reload) only counts the first time.
      if (initReceived) return;
      hostAuth = readAuth(payload.auth);
      markInitReceived();
      // The session started without waiting for this: hand it over like a login.
      if (initWaitExpired && hostAuth) emit({ type: 'login', auth: hostAuth });
      break;
    }
    case 'weld:auth:login': {
      const auth = readAuth(data.payload);
      if (!auth) return;
      // Name / email alone don't replace a token the page gave earlier.
      hostAuth = auth.identityToken ? auth : { ...auth, identityToken: hostAuth?.identityToken };
      markInitReceived();
      emit({ type: 'login', auth });
      break;
    }
    case 'weld:auth:logout':
      hostAuth = null;
      markInitReceived();
      emit({ type: 'logout' });
      break;
  }
}

if (embedded) window.addEventListener('message', onMessage);

/** What the host page last said about the visitor (null: nothing, or signed out). */
export function getHostAuth(): HostAuth | null {
  return hostAuth;
}

/** Resolves once the SDK's weld:init (or an auth message) arrived, or after a short wait. */
export function waitForHostInit(timeoutMs = INIT_WAIT_MS): Promise<void> {
  if (initReceived) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (expired = false) => {
      if (expired) initWaitExpired = true;
      clearTimeout(timer);
      initWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    initWaiters.add(done);
  });
}

export function onHostAuth(listener: (event: HostAuthEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The host site's name for "sign in on …" copy: the SDK's page origin, else the referrer. */
export function hostSiteName(): string | null {
  for (const candidate of [parentOrigin, globalThis.document?.referrer]) {
    if (!candidate || candidate === '*') continue;
    try {
      const host = new URL(candidate).hostname;
      if (host) return host.replace(/^www\./, '');
    } catch {
      // not a URL
    }
  }
  return null;
}
