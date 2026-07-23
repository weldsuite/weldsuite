import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { WeldApi } from '../core/api';
import { WeldAppBridge } from '../core/bridge';
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
}

const WeldAppContext = createContext<WeldAppContextValue | null>(null);

export interface WeldAppProviderProps {
  children: ReactNode;
  /** Bring your own bridge (e.g. shared with non-React code). Defaults to a fresh one. */
  bridge?: WeldAppBridge;
}

/**
 * Connects the iframe bridge to the WeldSuite host and exposes app context
 * (theme, locale, user, API client) to the tree.
 */
export function WeldAppProvider({ children, bridge: bridgeProp }: WeldAppProviderProps) {
  const bridgeRef = useRef<WeldAppBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = bridgeProp ?? new WeldAppBridge();
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
    }),
    [init, theme, locale, api, bridge, status, error],
  );

  return <WeldAppContext.Provider value={value}>{children}</WeldAppContext.Provider>;
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
export type { InitPayload, RecordsClient, WeldAppUser, WeldTheme };
