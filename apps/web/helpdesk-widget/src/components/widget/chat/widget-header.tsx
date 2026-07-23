/**
 * Widget Header Component
 * Clean minimal header with back button, avatar/name, and action buttons
 * Matches the platform's exact Intercom-style design
 */

import { ChevronLeft, X } from 'lucide-react';

interface WidgetHeaderProps {
  connectionState?: string;
  assignedAgent?: { id: string; name: string; avatar?: string } | null;
  botAgent?: { name: string; avatar?: string | null };
  disableBackNavigation?: boolean;
  parentOrigin?: string;
  onBack?: () => void;
  onClose?: () => void;
  headerColor?: string;
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
}

export function WidgetHeader({
  connectionState = 'disconnected',
  assignedAgent,
  botAgent,
  disableBackNavigation = false,
  parentOrigin,
  onBack,
  onClose,
  headerColor,
  replyTimeText,
  isWithinOfficeHours,
}: WidgetHeaderProps) {
  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      // In widget mode, tell the parent SDK to hide the widget
      if (!parentOrigin) {
        console.warn('SECURITY WARNING: parentOrigin not provided, using wildcard origin. This is insecure!');
      }
      window.parent.postMessage({ type: 'weld:close' }, parentOrigin || '*');
    }
  };

  // Display priority: human agent > bot agent from workflow > fallback
  const isHumanAgent = assignedAgent && assignedAgent.id !== 'ai-agent';
  const effectiveAgent = isHumanAgent
    ? assignedAgent
    : botAgent
      ? { id: 'bot' as const, name: botAgent.name, avatar: botAgent.avatar || undefined }
      : null;

  const displayName = effectiveAgent ? effectiveAgent.name : 'Chat Support';
  const displayInitial = displayName.charAt(0).toUpperCase();

  return (
    <div
      className="flex items-center px-3 border-b border-gray-200"
      style={{ height: '54px', ...(headerColor ? { backgroundColor: headerColor } : {}) }}
    >
      {/* Left side - Back arrow */}
      <div className="flex-1 flex items-center gap-1">
        <button
          onClick={onBack}
          disabled={disableBackNavigation}
          className="inline-flex items-center justify-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-300 disabled:pointer-events-none disabled:opacity-50 hover:bg-gray-100 h-8 w-8"
          style={{ marginLeft: '-1px', marginTop: '3px', borderRadius: '10px' }}
          aria-label="Go back"
        >
          <ChevronLeft className="h-4 w-4 text-gray-600" />
        </button>
      </div>

      {/* Center - Avatar and Name */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <div className="flex items-center justify-center overflow-hidden" style={{ borderRadius: '8px', width: '26px', height: '26px' }}>
            {effectiveAgent?.avatar ? (
              <img src={effectiveAgent.avatar} alt={displayName} className="w-full h-full object-cover rounded-full" />
            ) : effectiveAgent ? (
              <div className="w-full h-full flex items-center justify-center bg-blue-500 text-white text-xs font-medium rounded-full">
                {displayInitial}
              </div>
            ) : (
              <img src="/WeldAgent logo light.png" alt={displayName} className="w-full h-full object-cover" style={{ transform: 'scale(1.3)' }} />
            )}
          </div>
          {/* Status indicator on avatar */}
          {(() => {
            // When an effective agent exists (human or bot), show green (online)
            if (effectiveAgent) {
              return <div className="absolute w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white" style={{ bottom: '-3px', right: '-3px' }} />;
            }
            // Otherwise show connection/office-hours state
            if (isWithinOfficeHours === false) {
              return <div className="absolute w-2.5 h-2.5 bg-gray-400 rounded-full border-2 border-white" style={{ bottom: '-3px', right: '-3px' }} />;
            }
            if (connectionState === 'connected') {
              return <div className="absolute w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white" style={{ bottom: '-3px', right: '-3px' }} />;
            }
            if (connectionState === 'connecting' || connectionState === 'reconnecting') {
              return <div className="absolute w-2.5 h-2.5 bg-yellow-500 rounded-full border-2 border-white animate-pulse" style={{ bottom: '-3px', right: '-3px' }} />;
            }
            return null;
          })()}
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-gray-900 leading-tight" style={{ fontWeight: 550 }}>{displayName}</span>
          {(replyTimeText || effectiveAgent) && (
            <span className="text-[10px] text-gray-400 leading-tight">
              {isHumanAgent ? 'Online' : effectiveAgent ? 'AI Agent' : (isWithinOfficeHours === false ? 'Away' : replyTimeText)}
            </span>
          )}
        </div>
      </div>

      {/* Right side - Close button */}
      <div className="flex-1 flex justify-end gap-1">
        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-300 disabled:pointer-events-none disabled:opacity-50 hover:bg-gray-100 h-8 w-8"
          style={{ marginRight: '-2px', marginTop: '2px', borderRadius: '10px' }}
          aria-label="Close widget"
        >
          <X className="h-4 w-4 text-gray-600" />
        </button>
      </div>
    </div>
  );
}
