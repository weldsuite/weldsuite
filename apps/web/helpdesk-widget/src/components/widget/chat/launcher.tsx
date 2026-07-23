/**
 * Launcher Component
 * The floating button that opens the widget
 * Supports two modes:
 * - SDK mode (embedded in iframe): Button fills iframe, SDK handles positioning
 * - Standalone mode: Uses fixed positioning with offsets
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

// In Vite, assets in public folder are served from root
const weldDeskLogoSrc = '/welddesk-logo-light.png';

interface LauncherProps {
  parentOrigin?: string;
  launcherColor?: string;
  // Standalone mode props
  isOpen?: boolean;
  unreadCount?: number;
  onClick?: () => void;
}

const DEFAULT_LAUNCHER_COLOR = '#3472E8';

export function Launcher({
  parentOrigin,
  launcherColor,
  isOpen = false,
  unreadCount = 0,
  onClick
}: LauncherProps) {
  // Detect if we're embedded in an iframe (SDK mode)
  const [isEmbedded, setIsEmbedded] = useState(false);
  // Track if widget is open (for showing X vs chat icon)
  // In SDK mode, updated via messages. In standalone mode, use prop directly.
  const [sdkWidgetOpen, setSdkWidgetOpen] = useState(false);
  // Track unread count from SDK (SDK mode only)
  const [sdkUnreadCount, setSdkUnreadCount] = useState(0);

  useEffect(() => {
    try {
      const embedded = window.self !== window.top;
      setIsEmbedded(embedded);

      // If embedded, send weld:ready message to parent SDK
      if (embedded) {
        window.parent.postMessage({
          type: 'weld:ready',
          origin: 'launcher',
          timestamp: Date.now(),
          id: `weld:ready_${Date.now()}_launcher`,
          payload: {
            iframe: 'launcher',
            ready: true,
          }
        }, parentOrigin || '*');
      }
    } catch {
      // Cross-origin iframe - we're definitely embedded
      setIsEmbedded(true);
    }
  }, [parentOrigin]);

  // Listen for widget open/close messages from SDK
  useEffect(() => {
    if (!isEmbedded) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'weld:widget-opened') {
        setSdkWidgetOpen(true);
      }
      if (event.data?.type === 'weld:widget-closed') {
        setSdkWidgetOpen(false);
      }
      if (event.data?.type === 'weld:unread-count') {
        setSdkUnreadCount(event.data.count ?? 0);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isEmbedded]);

  const handleClick = () => {
    // Standalone mode - use onClick handler if provided
    if (onClick) {
      onClick();
      return;
    }

    // SDK mode - send message to parent SDK to toggle the widget iframe
    if (!parentOrigin) {
      console.warn('SECURITY WARNING: parentOrigin not provided, using wildcard origin. This is insecure!');
    }
    window.parent.postMessage({ type: 'launcher:clicked' }, parentOrigin || '*');
  };

  // In standalone mode, use the isOpen prop directly; in SDK mode, use message-driven state
  const showCloseIcon = onClick ? isOpen : sdkWidgetOpen;

  // In SDK mode, use count forwarded from widget iframe; in standalone mode, use prop
  const effectiveUnreadCount = isEmbedded ? sdkUnreadCount : unreadCount;

  const badge = effectiveUnreadCount > 0 && !showCloseIcon ? (
    <span
      className="absolute -top-1 -right-1 flex items-center justify-center min-w-[20px] h-[20px] px-1 rounded-full bg-red-500 text-white text-xs font-bold shadow-md"
      style={{ fontSize: '11px', lineHeight: 1 }}
    >
      {effectiveUnreadCount > 99 ? '99+' : effectiveUnreadCount}
    </span>
  ) : null;

  const iconContent = (
    <div className="relative w-[28px] h-[28px] flex items-center justify-center">
      {/* Logo icon - visible when closed */}
      <img
        src={weldDeskLogoSrc}
        alt="Help"
        className="absolute inset-0 m-auto object-contain transition-all duration-300 ease-in-out"
        style={{
          width: '27px',
          height: '27px',
          opacity: showCloseIcon ? 0 : 1,
          transform: showCloseIcon ? 'rotate(30deg) scale(0)' : 'rotate(0deg) scale(1)',
        }}
      />
      {/* Close arrow - visible when open */}
      <ChevronDown
        size={28}
        strokeWidth={2.5}
        className="absolute inset-0 m-auto text-white transition-all duration-300 ease-in-out"
        style={{
          opacity: showCloseIcon ? 1 : 0,
          transform: showCloseIcon ? 'rotate(0deg) scale(1)' : 'rotate(-30deg) scale(0)',
        }}
      />
    </div>
  );

  // In SDK mode (embedded), the button should fill the iframe completely
  // The SDK's IframeManager handles the positioning
  if (isEmbedded) {
    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <button
          onClick={handleClick}
          className="relative hover:scale-110 transition-all duration-200 flex items-center justify-center w-[60px] h-[60px]"
          style={{
            backgroundColor: launcherColor || DEFAULT_LAUNCHER_COLOR,
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
          }}
          aria-label={showCloseIcon ? "Close help widget" : "Open help widget"}
        >
          {iconContent}
          {badge}
        </button>
      </div>
    );
  }

  // Standalone mode - fixed positioning
  return (
    <button
      onClick={handleClick}
      className="fixed bottom-5 right-5 w-[60px] h-[60px] shadow-lg hover:shadow-xl hover:scale-110 transition-all duration-200 flex items-center justify-center z-[999998]"
      style={{
        backgroundColor: launcherColor || DEFAULT_LAUNCHER_COLOR,
        borderRadius: '50%',
      }}
      aria-label={showCloseIcon ? "Close help widget" : "Open help widget"}
    >
      {iconContent}
      {badge}
    </button>
  );
}
