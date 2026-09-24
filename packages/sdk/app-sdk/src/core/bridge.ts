import {
  buildLocalInitPayload,
  buildLocalTokenInfo,
  isLocalPreviewInit,
  LocalMemoryStore,
  shouldUseLocalDev,
  type WeldAppBridgeOptions,
} from './local-dev';
import { applyDesignTokens, applyTheme } from './appearance';
import type {
  AppMessage,
  BridgeEventName,
  BridgeFetchRequest,
  BridgeFetchResponse,
  BridgeRequestMethod,
  ConfirmOptions,
  HostMessage,
  InitPayload,
  ModalResult,
  OpenModalOptions,
  ShortcutPayload,
  ToastVariant,
  WeldBreadcrumb,
  WeldSurface,
  WeldTokenInfo,
} from './types';

/** Highest bridge protocol this SDK speaks. */
export const BRIDGE_PROTOCOL = 2;

/** How long we wait for the host's `weldapp:init` reply before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long we wait for a `weldapp:response` to a `weldapp:request`. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Proxied API calls may legitimately take longer than UI requests. */
const FETCH_TIMEOUT_MS = 60_000;

/** Platform shortcuts (with Cmd/Ctrl) handed to the host when unhandled. */
const HOST_SHORTCUT_KEYS = new Set(['k', 'j']);

/** Statuses whose Response must be constructed without a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

interface RequestOptions {
  /** Milliseconds, or `null` for user-driven requests (confirm, modals). */
  timeoutMs?: number | null;
}

/** Refresh the cached token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type EventCallback = (value: string) => void;

function expiresAtMs(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value);
}

/**
 * The app side of the WeldSuite iframe bridge.
 *
 * Lifecycle: the app boots inside a sandboxed iframe rendered by the
 * WeldSuite platform, calls `connect()` (posts `weldapp:ready`), and receives
 * `weldapp:init` with the app code, theme, locale, API base URL, a
 * workspace-scoped access token, and the current user.
 *
 * Local preview: pass `{ localDev: true }` (or `?weldLocal=1`) when opening
 * the Vite server outside the platform shell. Production iframe security is
 * unchanged — local mode never activates while embedded.
 */
export class WeldAppBridge {
  private initPayload: InitPayload | null = null;
  private connectPromise: Promise<InitPayload> | null = null;
  private initResolve: ((payload: InitPayload) => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<BridgeEventName, Set<EventCallback>>();
  private requestCounter = 0;
  private tokenInfo: WeldTokenInfo | null = null;
  private tokenRefreshPromise: Promise<WeldTokenInfo> | null = null;
  private listening = false;
  private localDevActive = false;
  /**
   * When true, in-memory storage is on but toast/navigate/getToken still go
   * through the real postMessage host (CLI local shell). Bare `localDev`
   * stubs those methods instead.
   */
  private hostBridgeActive = false;
  private readonly options: WeldAppBridgeOptions;
  private memoryStore: LocalMemoryStore | null = null;
  private mountedNotified = false;
  private shortcutsAttached = false;

  constructor(options: WeldAppBridgeOptions = {}) {
    this.options = options;
    // Resolve eagerly so WeldApi can branch before connect() finishes.
    this.activateLocalDevIfNeeded();
  }

  /**
   * True when running in local preview — bare tab mock **or** CLI local shell
   * (`init.localPreview`). App-storage is in-memory in both cases.
   */
  get isLocalDev(): boolean {
    return this.localDevActive;
  }

  /**
   * True when embedded in the CLI local shell: real postMessage bridge +
   * in-memory storage. False for bare-tab `localDev` stubs.
   */
  get isLocalShell(): boolean {
    return this.localDevActive && this.hostBridgeActive;
  }

  /** In-memory storage used only when {@link isLocalDev} is true. */
  get localStore(): LocalMemoryStore | null {
    return this.memoryStore;
  }

  /** The init payload, once connected. Theme/locale stay current with host events. */
  get init(): InitPayload | null {
    return this.initPayload;
  }

  get isConnected(): boolean {
    return this.initPayload !== null;
  }

  /** Protocol spoken by the connected host (1 until connected / for legacy hosts). */
  get protocol(): number {
    return this.initPayload?.protocol ?? 1;
  }

  /**
   * True when the host performs API requests for the app (protocol 2). The
   * iframe then never holds a token: the host calls the API with the
   * member's platform session, outside the sandbox.
   */
  get hostProxiesRequests(): boolean {
    if (this.localDevActive && !this.hostBridgeActive) {
      return false;
    }
    return this.protocol >= 2;
  }

  /** Where the host renders this instance (`page` or `modal`). */
  get surface(): WeldSurface {
    return this.initPayload?.surface ?? 'page';
  }

  /**
   * Perform the handshake with the WeldSuite host. Idempotent — concurrent
   * and repeated calls share one handshake. Rejects after 10s with a hint
   * that the app is probably not running inside WeldSuite.
   *
   * In local preview mode, resolves immediately with a mock payload.
   */
  connect(): Promise<InitPayload> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Re-check in case the constructor ran before window was ready, or the
    // URL gained `?weldLocal=1` after construction.
    this.activateLocalDevIfNeeded();

    if (this.localDevActive) {
      const payload = buildLocalInitPayload(this.options.local);
      this.initPayload = payload;
      this.tokenInfo = buildLocalTokenInfo(payload);
      this.applyAppearance(payload);
      this.connectPromise = Promise.resolve(payload);
      return this.connectPromise;
    }

    const promise = new Promise<InitPayload>((resolve, reject) => {
      if (typeof window === 'undefined') {
        reject(
          new Error(
            '@weldsuite/app-sdk: WeldAppBridge.connect() requires a browser environment (window is undefined).',
          ),
        );
        return;
      }
      if (window.parent === window) {
        reject(
          new Error(
            '@weldsuite/app-sdk: this page is not embedded in an iframe. ' +
              'WeldSuite apps normally run inside the WeldSuite platform — open `/apps/{code}` there, ' +
              'or use `weld app deploy` to upload a new version. ' +
              'For UI-only local preview without the host, opt in: pass `{ localDev: true }` to ' +
              '`createWeldApp` / `<WeldAppProvider>`, open with `?weldLocal=1`, or set ' +
              '`window.__WELD_LOCAL_DEV__ = true`.',
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.initResolve = null;
        reject(
          new Error(
            '@weldsuite/app-sdk: timed out after 10s waiting for the WeldSuite host to reply to `weldapp:ready`. ' +
              'This usually means the app is running outside WeldSuite (e.g. a plain `vite dev` tab). ' +
              'Open the app from within your WeldSuite workspace, or enable local preview ' +
              '(`localDev: true` / `?weldLocal=1`).',
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      this.initResolve = (payload) => {
        clearTimeout(timer);
        this.initResolve = null;
        resolve(payload);
      };

      this.attachListener();
      this.postToHost({ type: 'weldapp:ready' });
    });

    this.connectPromise = promise;
    // Allow a retry after a failed handshake.
    promise.catch(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    });
    return promise;
  }

  /**
   * Send a correlated request to the host and await its response.
   * Times out after 15s. Bare local preview stubs host methods; the CLI
   * local shell keeps the real postMessage path.
   */
  async request<TResult = unknown>(
    method: BridgeRequestMethod,
    payload?: unknown,
    options: RequestOptions = {},
  ): Promise<TResult> {
    await this.connect();

    if (this.localDevActive && !this.hostBridgeActive) {
      return this.handleLocalRequest<TResult>(method, payload);
    }

    const id = `req_${++this.requestCounter}_${Math.random().toString(36).slice(2, 10)}`;
    const timeoutMs = options.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(`@weldsuite/app-sdk: request "${method}" (${id}) timed out after ${timeoutMs / 1000}s.`),
              );
            }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const message: AppMessage = { type: 'weldapp:request', id, method };
      if (payload !== undefined) {
        (message as { payload?: unknown }).payload = payload;
      }
      this.postToHost(message);
    });
  }

  /**
   * Subscribe to a host push event (`theme` | `locale` | `route`).
   * Returns an unsubscribe function.
   */
  on(event: BridgeEventName, callback: EventCallback): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  /**
   * Get a valid workspace-scoped API token. Cached from the init payload and
   * refreshed via a `getToken` request when within 60s of expiry (or when
   * `forceRefresh` is set). Concurrent refreshes are deduplicated.
   *
   * @deprecated Legacy (protocol 1) path. Protocol 2 hosts proxy requests
   * ({@link hostProxiesRequests}) so the app never needs a token; `WeldApi`
   * only calls this against older hosts.
   */
  async getToken(options: { forceRefresh?: boolean } = {}): Promise<WeldTokenInfo> {
    await this.connect();

    if (!options.forceRefresh && this.tokenInfo) {
      const expiry = expiresAtMs(this.tokenInfo.tokenExpiresAt);
      if (Number.isFinite(expiry) && expiry - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
        return this.tokenInfo;
      }
    }

    // Bare localDev stubs getToken; CLI shell asks the host (which returns the mock).
    if (this.localDevActive && !this.hostBridgeActive) {
      const info = buildLocalTokenInfo(this.initPayload ?? buildLocalInitPayload(this.options.local));
      this.tokenInfo = info;
      return info;
    }

    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.request<WeldTokenInfo>('getToken')
        .then((info) => {
          this.tokenInfo = info;
          return info;
        })
        .finally(() => {
          this.tokenRefreshPromise = null;
        });
    }
    return this.tokenRefreshPromise;
  }

  /** Ask the host to navigate the platform to another route. */
  async navigate(to: string): Promise<void> {
    await this.request('navigate', { to });
  }

  /** Ask the host to show a toast in the platform shell. */
  async toast(message: string, variant: ToastVariant = 'default'): Promise<void> {
    await this.request('toast', { message, variant });
  }

  /**
   * Perform an API request through the host (protocol 2). The host attaches
   * the member's session outside the sandbox and returns the response.
   * `WeldApi` uses this automatically; call it directly only for raw access.
   */
  async hostFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: [string, string][] = [];
    new Headers(init.headers).forEach((value, name) => {
      headers.push([name, value]);
    });
    const { body, contentType } = await serializeBody(init.body);
    if (contentType && !headers.some(([name]) => name === 'content-type')) {
      headers.push(['content-type', contentType]);
    }
    const payload: BridgeFetchRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      headers,
      body,
    };
    const result = await this.request<BridgeFetchResponse>('fetch', payload, { timeoutMs: FETCH_TIMEOUT_MS });
    const responseBody = NULL_BODY_STATUSES.has(result.status) ? null : result.body;
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText ?? '',
      headers: result.headers,
    });
  }

  /**
   * Replace the app-level breadcrumbs in the platform header. The host keeps
   * the app name as the first crumb; `path` values are app-relative.
   */
  async setBreadcrumbs(items: WeldBreadcrumb[]): Promise<void> {
    await this.request('setBreadcrumbs', { items });
  }

  /**
   * Mark unsaved changes. While dirty, the host asks the member to confirm
   * before navigating away from the app or closing the tab.
   */
  async setDirty(dirty: boolean, message?: string): Promise<void> {
    await this.request('setDirty', { dirty, message });
  }

  /** Show a platform confirmation dialog; resolves `true` when confirmed. */
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const result = await this.request<{ confirmed?: boolean }>('confirm', options, { timeoutMs: null });
    return result?.confirmed === true;
  }

  /**
   * Open another route of this app in a platform modal. Resolves when it
   * closes: with the value passed to {@link closeModal}, or `dismissed`.
   */
  async openModal<T = unknown>(options: OpenModalOptions): Promise<ModalResult<T>> {
    const result = await this.request<ModalResult<T>>('openModal', options, { timeoutMs: null });
    return { dismissed: result?.dismissed !== false, result: result?.result };
  }

  /** From inside a modal instance: close it and hand `result` to the opener. */
  async closeModal(result?: unknown): Promise<void> {
    await this.request('closeModal', { result });
  }

  /**
   * Tell the host the app has rendered its first screen, so it can swap its
   * loading skeleton for the iframe without a blank flash. Idempotent.
   * `WeldAppProvider` calls this for you.
   */
  notifyMounted(): void {
    if (this.mountedNotified || !this.isConnected) {
      return;
    }
    if (this.localDevActive && !this.hostBridgeActive) {
      return;
    }
    this.mountedNotified = true;
    this.postToHost({ type: 'weldapp:notify', event: 'mounted' });
  }

  /** Detach the message listener and fail all in-flight requests. */
  destroy(): void {
    if (this.listening && typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage);
      this.listening = false;
    }
    if (this.shortcutsAttached && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleKeydown);
      this.shortcutsAttached = false;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`@weldsuite/app-sdk: bridge destroyed while request ${id} was in flight.`));
    }
    this.pending.clear();
    this.listeners.clear();
    this.connectPromise = null;
    this.initResolve = null;
  }

  private activateLocalDevIfNeeded(): void {
    if (this.localDevActive) {
      return;
    }
    if (!shouldUseLocalDev(this.options)) {
      return;
    }
    this.localDevActive = true;
    this.memoryStore = new LocalMemoryStore();
  }

  private handleLocalRequest<TResult>(method: BridgeRequestMethod, payload?: unknown): TResult {
    switch (method) {
      case 'getToken': {
        const info = buildLocalTokenInfo(this.initPayload ?? buildLocalInitPayload(this.options.local));
        this.tokenInfo = info;
        return info as TResult;
      }
      case 'navigate': {
        if (typeof console !== 'undefined' && console.debug) {
          const to = (payload as { to?: string } | undefined)?.to;
          console.debug(`[weld local preview] navigate(${JSON.stringify(to ?? '')}) — no-op`);
        }
        return undefined as TResult;
      }
      case 'toast': {
        if (typeof console !== 'undefined' && console.debug) {
          const message = (payload as { message?: string; variant?: string } | undefined)?.message;
          const variant = (payload as { variant?: string } | undefined)?.variant ?? 'default';
          console.debug(`[weld local preview] toast(${JSON.stringify(message ?? '')}, ${variant}) — no-op`);
        }
        return undefined as TResult;
      }
      case 'setBreadcrumbs':
      case 'setDirty':
      case 'closeModal': {
        return undefined as TResult;
      }
      case 'confirm': {
        const options = (payload ?? {}) as Partial<ConfirmOptions>;
        const text = [options.title, options.description].filter(Boolean).join('\n\n');
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : false;
        return { confirmed } as TResult;
      }
      case 'openModal': {
        if (typeof console !== 'undefined' && console.debug) {
          const path = (payload as { path?: string } | undefined)?.path;
          console.debug(`[weld local preview] openModal(${JSON.stringify(path ?? '')}) — no host, dismissed`);
        }
        return { dismissed: true } as TResult;
      }
      default: {
        throw new Error(`@weldsuite/app-sdk: unknown host method "${method as string}" in local preview.`);
      }
    }
  }

  private attachListener(): void {
    if (this.listening) {
      return;
    }
    window.addEventListener('message', this.handleMessage);
    this.listening = true;
    if (this.options.forwardShortcuts !== false && !this.shortcutsAttached) {
      window.addEventListener('keydown', this.handleKeydown);
      this.shortcutsAttached = true;
    }
  }

  private applyAppearance(payload: InitPayload): void {
    if (this.options.applyAppearance === false) {
      return;
    }
    applyTheme(payload.theme);
    applyDesignTokens(payload.designTokens);
  }

  /**
   * Bubble-phase listener: an app that handles Cmd/Ctrl+K itself calls
   * `preventDefault()` and keeps it; otherwise the platform gets it.
   */
  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (!HOST_SHORTCUT_KEYS.has(key)) {
      return;
    }
    event.preventDefault();
    const payload: ShortcutPayload = {
      key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    };
    this.postToHost({ type: 'weldapp:notify', event: 'shortcut', payload });
  };

  /**
   * Post a message to the embedding WeldSuite host.
   *
   * Why `targetOrigin: '*'`: the app runs inside a *sandboxed* iframe whose
   * own origin is opaque, and the platform host is served from
   * per-deployment hostnames the app bundle cannot know at build time, so a
   * concrete target origin is unavailable. This is acceptable because
   * app → host messages never carry secrets — `weldapp:ready` is an empty
   * ping and `weldapp:request` payloads are the app's own UI intents. All
   * sensitive data (tokens) flows host → app, where the host posts directly
   * into this iframe's contentWindow. Inbound messages are additionally
   * filtered to `event.source === window.parent`.
   */
  private postToHost(message: AppMessage): void {
    window.parent.postMessage(message, '*');
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    // Only accept messages from the embedding parent (the WeldSuite host).
    if (event.source !== window.parent) {
      return;
    }
    const message = event.data as HostMessage | null;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'weldapp:init': {
        this.initPayload = message.payload;
        // Protocol 2 hosts send no token (requests are proxied); a legacy
        // host's token is cached for the direct-fetch path.
        this.tokenInfo =
          typeof message.payload.token === 'string' && message.payload.tokenExpiresAt !== null
            ? {
                token: message.payload.token,
                tokenExpiresAt: message.payload.tokenExpiresAt,
                apiBaseUrl: message.payload.apiBaseUrl,
              }
            : null;
        this.applyAppearance(message.payload);
        // CLI local shell: keep memory store + real bridge for host methods.
        if (isLocalPreviewInit(message.payload)) {
          this.localDevActive = true;
          this.hostBridgeActive = true;
          if (!this.memoryStore) {
            this.memoryStore = new LocalMemoryStore();
          }
        }
        this.initResolve?.(message.payload);
        break;
      }
      case 'weldapp:response': {
        const entry = this.pending.get(message.id);
        if (!entry) {
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message.payload);
        } else {
          entry.reject(new Error(message.error?.message ?? '@weldsuite/app-sdk: host reported an unknown error.'));
        }
        break;
      }
      case 'weldapp:event': {
        if (message.event === 'designTokens') {
          const tokens = message.payload?.value;
          if (this.initPayload && tokens) {
            this.initPayload = { ...this.initPayload, designTokens: tokens };
          }
          if (this.options.applyAppearance !== false) {
            applyDesignTokens(tokens);
          }
          return;
        }
        const value = message.payload?.value;
        if (typeof value !== 'string') {
          return;
        }
        if (message.event === 'theme' && (value === 'light' || value === 'dark') && this.options.applyAppearance !== false) {
          applyTheme(value);
        }
        // Keep the init snapshot current so late readers see fresh values.
        if (this.initPayload) {
          if (message.event === 'theme' && (value === 'light' || value === 'dark')) {
            this.initPayload = { ...this.initPayload, theme: value };
          } else if (message.event === 'locale') {
            this.initPayload = { ...this.initPayload, locale: value };
          } else if (message.event === 'route') {
            this.initPayload = { ...this.initPayload, path: value };
          }
        }
        const set = this.listeners.get(message.event);
        if (set) {
          for (const callback of set) {
            callback(value);
          }
        }
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Convert a fetch body into something postMessage can carry. Streams and
 * FormData cannot cross the bridge; send JSON, text, Blob or bytes.
 */
async function serializeBody(
  body: BodyInit | null | undefined,
): Promise<{ body: string | ArrayBuffer | null; contentType?: string }> {
  if (body === null || body === undefined) {
    return { body: null };
  }
  if (typeof body === 'string') {
    return { body };
  }
  if (body instanceof ArrayBuffer) {
    return { body };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes.slice().buffer };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { body: await body.arrayBuffer(), contentType: body.type || undefined };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { body: body.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  throw new Error(
    '@weldsuite/app-sdk: this request body cannot be sent through the WeldSuite host. ' +
      'Use a string (e.g. JSON), Blob, ArrayBuffer, typed array or URLSearchParams.',
  );
}
