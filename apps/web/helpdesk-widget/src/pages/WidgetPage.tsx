import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { widgetApi } from '@/lib/api/client';
import type { WidgetConfigResponse } from '@/lib/api/types';
import { Messenger } from '@/components/messenger/messenger';
import { Launcher } from '@/components/widget/chat/launcher';
import { WidgetErrorBoundary } from '@/components/widget/error-boundary';

const ENV_REALTIME_URL = (import.meta.env.VITE_WIDGET_REALTIME_URL as string | undefined) || null;

function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * The messenger page. Embedded (SDK iframe) it fills the frame and talks to
 * the parent over postMessage; opened directly it renders its own launcher.
 *
 * SDK protocol (packages/sdk/helpdesk-widget-sdk):
 *   → weld:ready {iframe:'widget'}   once mounted (SDK waits for it)
 *   ← weld:open / weld:close         panel visibility
 *   → weld:close                     visitor pressed close
 *   → weld:unread-count {count}      forwarded to the launcher badge
 */
export function WidgetPage() {
  const [searchParams] = useSearchParams();
  const widgetId = searchParams.get('widgetId') || searchParams.get('id') || import.meta.env.VITE_DEFAULT_WIDGET_ID || '';
  const parentOrigin = searchParams.get('parentOrigin') || '*';
  const embedded = isEmbedded();

  const [config, setConfig] = useState<WidgetConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(!embedded && searchParams.get('open') === 'true');

  const postToParent = useCallback(
    (message: Record<string, unknown>) => {
      if (!embedded) return;
      try {
        window.parent.postMessage(message, parentOrigin);
      } catch {
        // parent went away
      }
    },
    [embedded, parentOrigin],
  );

  useEffect(() => {
    if (!widgetId) {
      setError('Missing widgetId');
      return;
    }
    let cancelled = false;
    const load = (attempt: number) => {
      widgetApi
        .getConfig(widgetId)
        .then((result) => !cancelled && setConfig(result))
        .catch((err: Error) => {
          if (cancelled) return;
          // A cold worker or flaky network shouldn't leave a dead widget.
          if (attempt < 3) setTimeout(() => load(attempt + 1), 1000 * 2 ** attempt);
          else setError(err.message);
        });
    };
    load(0);
    return () => {
      cancelled = true;
    };
  }, [widgetId]);

  // SDK handshake + visibility.
  useEffect(() => {
    if (!embedded) return;
    const sendReady = () =>
      postToParent({
        type: 'weld:ready',
        origin: 'widget',
        timestamp: Date.now(),
        id: `weld:ready_${Date.now()}_widget`,
        payload: { iframe: 'widget', ready: true },
      });
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type === 'weld:open') setIsOpen(true);
      else if (type === 'weld:close') setIsOpen(false);
      else if (type === 'weld:init') sendReady();
    };
    window.addEventListener('message', onMessage);
    sendReady();
    return () => window.removeEventListener('message', onMessage);
  }, [embedded, postToParent]);

  const [unread, setUnread] = useState(0);
  const handleUnread = useCallback(
    (count: number) => {
      setUnread(count);
      postToParent({ type: 'weld:unread-count', count });
    },
    [postToParent],
  );

  const close = useCallback(() => {
    if (embedded) postToParent({ type: 'weld:close' });
    setIsOpen(false);
  }, [embedded, postToParent]);

  if (error) {
    return <div className="p-4 text-sm text-red-600">{error}</div>;
  }
  if (!config) {
    return embedded ? <div className="h-full w-full bg-white" /> : null;
  }

  const realtimeUrl = searchParams.get('realtimeUrl') || config.realtimeUrl || ENV_REALTIME_URL;
  const messenger = (
    <WidgetErrorBoundary>
      <Messenger
        config={config}
        isOpen={isOpen}
        onClose={close}
        onUnreadChange={handleUnread}
        initialName={searchParams.get('name') || undefined}
        initialEmail={searchParams.get('email') || undefined}
        realtimeUrl={realtimeUrl}
      />
    </WidgetErrorBoundary>
  );

  if (embedded) {
    return <div className="h-full w-full">{messenger}</div>;
  }

  // Standalone page (direct link / local testing): floating panel + launcher.
  const side = config.branding.position === 'left' ? 'left-5' : 'right-5';
  return (
    <>
      <div
        className={`fixed bottom-[92px] ${side} z-[999999] h-[min(680px,calc(100vh-120px))] w-[400px] max-w-[calc(100vw-40px)] overflow-hidden rounded-2xl border border-black/10 shadow-2xl transition-all duration-200 ${
          isOpen ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 translate-y-3'
        }`}
        aria-hidden={!isOpen}
      >
        {messenger}
      </div>
      <Launcher
        launcherColor={config.branding.primaryColor}
        isOpen={isOpen}
        unreadCount={unread}
        onClick={() => setIsOpen((v) => !v)}
      />
    </>
  );
}
