import { useEffect, useRef, useCallback, useState } from 'react';
import { WeldSDK, type WeldConfig } from '../../src/index';

/**
 * Hook return type with loading and error states
 */
export interface UseHelpdeskWidgetResult {
  /** The SDK instance (null during loading or if error) */
  widget: WeldSDK | null;
  /** Whether the widget is currently initializing */
  isLoading: boolean;
  /** Whether the widget is ready to use */
  isReady: boolean;
  /** Error if initialization failed */
  error: Error | null;
}

/**
 * React hook for the Helpdesk Widget
 *
 * @example
 * ```tsx
 * function App() {
 *   const { widget, isReady, isLoading, error } = useHelpdeskWidget({
 *     widgetId: 'your-widget-id'
 *   });
 *
 *   if (isLoading) return <div>Loading widget...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <button onClick={() => widget?.open()} disabled={!isReady}>
 *       Show Support
 *     </button>
 *   );
 * }
 * ```
 */
export function useHelpdeskWidget(config: WeldConfig): UseHelpdeskWidgetResult {
  const widgetRef = useRef<WeldSDK | null>(null);
  const configRef = useRef(config);
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Update config ref when config changes
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    let mounted = true;
    let widget: WeldSDK | null = null;

    const initWidget = async () => {
      try {
        setIsLoading(true);
        setError(null);

        widget = new WeldSDK(configRef.current);
        widgetRef.current = widget;

        // Wait for init to complete
        await widget.init();

        if (mounted) {
          setIsReady(true);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to initialize Helpdesk Widget:', err);
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
          setIsReady(false);
        }
      }
    };

    initWidget();

    // Cleanup on unmount
    return () => {
      mounted = false;
      if (widgetRef.current) {
        widgetRef.current.destroy();
        widgetRef.current = null;
      }
    };
  }, []);

  return {
    widget: widgetRef.current,
    isLoading,
    isReady,
    error,
  };
}

/**
 * Legacy hook that returns just the widget (for backwards compatibility)
 * @deprecated Use useHelpdeskWidget instead which returns { widget, isReady, isLoading, error }
 */
export function useHelpdeskWidgetLegacy(config: WeldConfig): WeldSDK | null {
  const { widget } = useHelpdeskWidget(config);
  return widget;
}

/**
 * Hook that provides widget control methods
 *
 * @example
 * ```tsx
 * function App() {
 *   const { open, close, toggle, isReady, isLoading, error } = useHelpdeskWidgetControls({
 *     widgetId: 'your-widget-id'
 *   });
 *
 *   if (isLoading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <button onClick={open} disabled={!isReady}>Show Support</button>
 *   );
 * }
 * ```
 */
export function useHelpdeskWidgetControls(config: WeldConfig) {
  const { widget, isReady, isLoading, error } = useHelpdeskWidget(config);

  const open = useCallback(() => {
    widget?.open();
  }, [widget]);

  const close = useCallback(() => {
    widget?.close();
  }, [widget]);

  const toggle = useCallback(() => {
    widget?.toggle();
  }, [widget]);

  const sendMessage = useCallback(
    (message: string) => {
      widget?.sendMessage(message);
    },
    [widget]
  );

  return {
    widget,
    isReady,
    isLoading,
    error,
    open,
    close,
    toggle,
    sendMessage,
  };
}
