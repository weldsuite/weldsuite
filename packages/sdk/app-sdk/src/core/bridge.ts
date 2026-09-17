import {
  buildLocalInitPayload,
  buildLocalTokenInfo,
  LocalMemoryStore,
  shouldUseLocalDev,
  type WeldAppBridgeOptions,
} from './local-dev';
import type {
  AppMessage,
  BridgeEventName,
  BridgeRequestMethod,
  HostMessage,
  InitPayload,
  ToastVariant,
  WeldTokenInfo,
} from './types';

/** How long we wait for the host's `weldapp:init` reply before giving up. */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long we wait for a `weldapp:response` to a `weldapp:request`. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Refresh the cached token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly options: WeldAppBridgeOptions;
  private memoryStore: LocalMemoryStore | null = null;

  constructor(options: WeldAppBridgeOptions = {}) {
    this.options = options;
    // Resolve eagerly so WeldApi can branch before connect() finishes.
    this.activateLocalDevIfNeeded();
  }

  /** True when running in local preview (mock host, no platform iframe). */
  get isLocalDev(): boolean {
    return this.localDevActive;
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
   * Times out after 15s. In local preview, host methods are stubbed.
   */
  async request<TResult = unknown>(method: BridgeRequestMethod, payload?: unknown): Promise<TResult> {
    await this.connect();

    if (this.localDevActive) {
      return this.handleLocalRequest<TResult>(method, payload);
    }

    const id = `req_${++this.requestCounter}_${Math.random().toString(36).slice(2, 10)}`;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`@weldsuite/app-sdk: request "${method}" (${id}) timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`),
        );
      }, REQUEST_TIMEOUT_MS);

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
   * Subscribe to a host push event (`theme` | `locale`).
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
   */
  async getToken(options: { forceRefresh?: boolean } = {}): Promise<WeldTokenInfo> {
    await this.connect();

    if (!options.forceRefresh && this.tokenInfo) {
      const expiry = expiresAtMs(this.tokenInfo.tokenExpiresAt);
      if (Number.isFinite(expiry) && expiry - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
        return this.tokenInfo;
      }
    }

    if (this.localDevActive) {
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

  /** Detach the message listener and fail all in-flight requests. */
  destroy(): void {
    if (this.listening && typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage);
      this.listening = false;
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
  }

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
        this.tokenInfo = {
          token: message.payload.token,
          tokenExpiresAt: message.payload.tokenExpiresAt,
          apiBaseUrl: message.payload.apiBaseUrl,
        };
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
        const value = message.payload?.value;
        if (typeof value !== 'string') {
          return;
        }
        // Keep the init snapshot current so late readers see fresh values.
        if (this.initPayload) {
          if (message.event === 'theme' && (value === 'light' || value === 'dark')) {
            this.initPayload = { ...this.initPayload, theme: value };
          } else if (message.event === 'locale') {
            this.initPayload = { ...this.initPayload, locale: value };
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
