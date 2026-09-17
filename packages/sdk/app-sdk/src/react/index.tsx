import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { WeldApi } from '../core/api';
import { WeldAppBridge } from '../core/bridge';
import type { LocalDevOptions, WeldAppBridgeOptions } from '../core/local-dev';
import type { InitPayload, RecordsClient, WeldAppUser, WeldTheme } from '../core/types';

export type WeldAppStatus = 'connecting' | 'ready' | 'error';

export interface WeldAppContextValue {
  /** The app code from the init payload, or null while connecting. */
  app: string | null;
  theme: WeldTheme;
  locale: string;
  user: WeldAppUser | null;
  api: WeldApi;
  bridge: WeldAppBridge;
  status: WeldAppStatus;
  error: Error | null;
  /** True when the mock local-preview bridge is active. */
  isLocalDev: boolean;
}

const WeldAppContext = createContext<WeldAppContextValue | null>(null);

export interface WeldAppProviderProps {
  children: ReactNode;
  /** Bring your own bridge (e.g. shared with non-React code). Defaults to a fresh one. */
  bridge?: WeldAppBridge;
  /**
   * Opt into local preview when the page is not iframed. Safe with
   * `import.meta.env.DEV`: when `weld app dev` embeds the same server in the
   * platform host, the real bridge is still used.
   */
  localDev?: boolean;
  /** Customize the mock init payload for local preview. */
  local?: LocalDevOptions;
  /** Hide the built-in “Local preview” banner. Default: show when local. */
  hideLocalBanner?: boolean;
}

const bannerStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 9999,
  margin: 0,
  padding: '8px 12px',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: '13px',
  lineHeight: 1.4,
  textAlign: 'center',
  color: '#1a1a1a',
  background: '#f5e6a8',
  borderBottom: '1px solid #e0c96a',
};

/** Fixed banner shown during local preview (no platform host). */
export function LocalPreviewBanner(): ReactNode {
  return (
    <p role="status" data-weld-local-preview-banner="" style={bannerStyle}>
      Local preview — not connected to WeldSuite
    </p>
  );
}

/**
 * Connects the iframe bridge to the WeldSuite host and exposes app context
 * (theme, locale, user, API client) to the tree.
 */
export function WeldAppProvider({
  children,
  bridge: bridgeProp,
  localDev,
  local,
  hideLocalBanner = false,
}: WeldAppProviderProps) {
  const bridgeRef = useRef<WeldAppBridge | null>(null);
  if (bridgeRef.current === null) {
    if (bridgeProp) {
      bridgeRef.current = bridgeProp;
    } else {
      const options: WeldAppBridgeOptions = {};
      if (localDev !== undefined) {
        options.localDev = localDev;
      }
      if (local !== undefined) {
        options.local = local;
      }
      bridgeRef.current = new WeldAppBridge(options);
    }
  }
  const bridge = bridgeRef.current;

  const api = useMemo(() => new WeldApi(bridge), [bridge]);
  const [status, setStatus] = useState<WeldAppStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [init, setInit] = useState<InitPayload | null>(null);
  const [theme, setTheme] = useState<WeldTheme>('light');
  const [locale, setLocale] = useState<string>('en');

  useEffect(() => {
    let cancelled = false;

    bridge
      .connect()
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setInit(payload);
        setTheme(payload.theme);
        setLocale(payload.locale);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setStatus('error');
      });

    const offTheme = bridge.on('theme', (value) => {
      if (value === 'light' || value === 'dark') {
        setTheme(value);
      }
    });
    const offLocale = bridge.on('locale', (value) => {
      setLocale(value);
    });

    return () => {
      cancelled = true;
      offTheme();
      offLocale();
    };
  }, [bridge]);

  const value = useMemo<WeldAppContextValue>(
    () => ({
      app: init?.appCode ?? null,
      theme,
      locale,
      user: init?.user ?? null,
      api,
      bridge,
      status,
      error,
      isLocalDev: bridge.isLocalDev,
    }),
    [init, theme, locale, api, bridge, status, error],
  );

  return (
    <WeldAppContext.Provider value={value}>
      {bridge.isLocalDev && !hideLocalBanner ? <LocalPreviewBanner /> : null}
      {children}
    </WeldAppContext.Provider>
  );
}

/** Access the WeldSuite app context. Must be used inside a WeldAppProvider. */
export function useWeldApp(): WeldAppContextValue {
  const context = useContext(WeldAppContext);
  if (!context) {
    throw new Error('@weldsuite/app-sdk: useWeldApp() must be used inside a <WeldAppProvider>.');
  }
  return context;
}

/** The bound API client. */
export function useWeldApi(): WeldApi {
  return useWeldApp().api;
}

/**
 * Typed accessor for one app-storage collection. Intentionally thin — no
 * query-library dependency; pair it with your data fetching of choice.
 */
export function useCollection<T extends Record<string, unknown> = Record<string, unknown>>(
  collection: string,
): RecordsClient<T> {
  const api = useWeldApi();
  return useMemo(() => api.records<T>(collection), [api, collection]);
}

export interface WeldAppGateProps {
  children: ReactNode;
  /** Rendered while the bridge is connecting. */
  fallback?: ReactNode;
  /** Rendered when the handshake failed. Defaults to the error message. */
  errorFallback?: ReactNode;
}

/** Renders children only once the bridge handshake completed. */
export function WeldAppGate({ children, fallback = null, errorFallback }: WeldAppGateProps) {
  const { status, error } = useWeldApp();
  if (status === 'ready') {
    return <>{children}</>;
  }
  if (status === 'error') {
    return <>{errorFallback ?? <p role="alert">{error?.message ?? 'Failed to connect to WeldSuite.'}</p>}</>;
  }
  return <>{fallback}</>;
}

export { WeldApi, WeldAppBridge };
export type { InitPayload, LocalDevOptions, RecordsClient, WeldAppUser, WeldTheme };
