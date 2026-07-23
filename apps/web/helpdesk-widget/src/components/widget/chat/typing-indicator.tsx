/**
 * Typing Indicator Component
 * Animated dots to show agent is typing, with optional agent name/avatar
 */

interface TypingIndicatorProps {
  agentBubbleColor?: string;
  agentName?: string;
  agentAvatar?: string;
  isBot?: boolean;
}

export function TypingIndicator({ agentBubbleColor, agentName, agentAvatar, isBot }: TypingIndicatorProps) {
  return (
    <div className="flex justify-start items-end gap-2">
      {/* Agent avatar */}
      {agentAvatar ? (
        <img
          src={agentAvatar}
          alt={agentName || 'Agent'}
          className="w-6 h-6 rounded-full object-cover flex-shrink-0"
        />
      ) : agentName ? (
        <div className="w-6 h-6 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-medium text-gray-600">
            {agentName.charAt(0).toUpperCase()}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col">
        {/* Agent name with AI badge */}
        {agentName && (
          <span className="text-[11px] text-gray-400 mb-0.5 pl-1 flex items-center gap-1">
            {agentName}
            {isBot && (
              <span className="text-[9px] bg-gray-200 text-gray-500 px-1 py-px rounded font-medium">
                AI
              </span>
            )}
          </span>
        )}

        <div className="px-4 py-4 rounded-2xl" style={{ backgroundColor: agentBubbleColor || '#F5F5F5', borderBottomLeftRadius: '4px' }}>
          <div className="flex space-x-1">
            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" />
            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.15s' }} />
            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
