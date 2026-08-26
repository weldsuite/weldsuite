import { useCallback, useEffect, useState } from 'react';
import { Launcher } from './chat/launcher';
import { ChatView } from './chat/chat-view';
import { WidgetErrorBoundary } from './error-boundary';
import { WidgetConfigProvider } from '@/providers/widget-config-provider';
import { CustomerProvider } from '@/providers/customer-provider';

interface HelpdeskWidgetProps {
  widgetId: string;
  greeting: string;
  primaryColor?: string;
  backgroundColor?: string;
  position?: 'right' | 'left';
  showBranding?: boolean;
  parentOrigin?: string;
  realtimeUrl?: string;
  mode?: 'launcher' | 'widget';
  defaultOpen?: boolean;
  customerEmail?: string;
  customerName?: string;
}

export function HelpdeskWidget({
  widgetId,
  greeting,
  primaryColor = '#2563eb',
  backgroundColor = '#ffffff',
  position = 'right',
  showBranding = true,
  parentOrigin,
  realtimeUrl,
  mode = 'widget',
  defaultOpen = false,
  customerEmail,
  customerName,
}: HelpdeskWidgetProps) {
  const [open, setOpen] = useState(defaultOpen);

  const notifyParent = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      if (!parentOrigin) return;
      try {
        window.parent.postMessage({ type, payload, origin: 'widget' }, parentOrigin);
      } catch {
        // ignore
      }
    },
    [parentOrigin],
  );

  useEffect(() => {
    notifyParent(open ? 'weld:open' : 'weld:close');
  }, [open, notifyParent]);

  if (mode === 'launcher') {
    return <Launcher parentOrigin={parentOrigin} launcherColor={primaryColor} isOpen={open} onClick={() => setOpen((v) => !v)} />;
  }

  return (
    <WidgetErrorBoundary>
      <WidgetConfigProvider
        value={{
          widgetId,
          greeting,
          primaryColor,
          backgroundColor,
          position,
          showBranding,
          parentOrigin,
          realtimeUrl,
        }}
      >
        <CustomerProvider widgetId={widgetId} initialEmail={customerEmail} initialName={customerName}>
          <div className="h-full w-full flex flex-col" style={{ backgroundColor }}>
            {open || defaultOpen || window.self !== window.top ? (
              <ChatView onClose={() => setOpen(false)} />
            ) : (
              <Launcher parentOrigin={parentOrigin} launcherColor={primaryColor} isOpen={open} onClick={() => setOpen(true)} />
            )}
          </div>
        </CustomerProvider>
      </WidgetConfigProvider>
    </WidgetErrorBoundary>
  );
}
