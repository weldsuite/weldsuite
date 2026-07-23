
/**
 * Presence Indicator Component
 *
 * Shows avatars of users currently viewing/editing the whiteboard.
 * Displays a stack of user avatars with tooltips.
 */

import { memo } from 'react';
import type { WhiteboardPresence } from '@/lib/realtime/whiteboard/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface PresenceIndicatorProps {
  presence: WhiteboardPresence[];
  isConnected: boolean;
  className?: string;
}

function getInitials(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

const PresenceAvatar = memo(function PresenceAvatar({
  user,
  index,
}: {
  user: WhiteboardPresence;
  index: number;
}) {
  const st = useTranslations();
  const isActive = Date.now() - user.lastActivity < 10000; // Active in last 10 seconds

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'relative transition-transform hover:z-10 hover:scale-110',
              index > 0 && '-ml-2'
            )}
            style={{ zIndex: 10 - index }}
          >
            <Avatar className="h-7 w-7 border-2 border-background shadow-sm">
              {user.avatar ? (
                <AvatarImage src={user.avatar} alt={user.name} />
              ) : null}
              <AvatarFallback
                style={{ backgroundColor: user.color }}
                className="text-[10px] font-medium text-white"
              >
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            {isActive && (
              <div
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background"
                style={{ backgroundColor: '#22c55e' }}
              />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="flex flex-col">
            <span className="font-medium">{user.name}</span>
            {user.tool && (
              <span className="text-muted-foreground">{st('sweep.weldflow.presenceIndicator.using', { tool: user.tool })}</span>
            )}
            {user.selectedElements && user.selectedElements.length > 0 && (
              <span className="text-muted-foreground">
                {st('sweep.weldflow.presenceIndicator.editingElements', { count: user.selectedElements.length })}
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export const PresenceIndicator = memo(function PresenceIndicator({
  presence,
  isConnected,
  className,
}: PresenceIndicatorProps) {
  const maxVisible = 5;
  const visibleUsers = presence.slice(0, maxVisible);
  const hiddenCount = Math.max(0, presence.length - maxVisible);

  if (visibleUsers.length === 0) return null;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* User avatars */}
      {visibleUsers.length > 0 && (
        <div className="flex items-center">
          {visibleUsers.map((user, index) => (
            <PresenceAvatar key={user.id} user={user} index={index} />
          ))}
          {hiddenCount > 0 && (
            <div
              className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium shadow-sm"
              style={{ zIndex: 10 - maxVisible }}
            >
              +{hiddenCount}
            </div>
          )}
        </div>
      )}

    </div>
  );
});

/**
 * Element Edit Indicator
 *
 * Shows a visual indicator on elements being edited by other users.
 */
interface ElementEditIndicatorProps {
  editor: WhiteboardPresence;
  elementBounds: { x: number; y: number; width: number; height: number };
  viewTransform: { x: number; y: number; scale: number };
}

const ElementEditIndicator = memo(function ElementEditIndicator({
  editor,
  elementBounds,
  viewTransform,
}: ElementEditIndicatorProps) {
  const st = useTranslations();
  // Transform canvas coordinates to screen coordinates
  const screenX = elementBounds.x * viewTransform.scale + viewTransform.x;
  const screenY = elementBounds.y * viewTransform.scale + viewTransform.y;
  const screenWidth = elementBounds.width * viewTransform.scale;
  const screenHeight = elementBounds.height * viewTransform.scale;

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: screenX - 2,
        top: screenY - 2,
        width: screenWidth + 4,
        height: screenHeight + 4,
        border: `2px dashed ${editor.color}`,
        borderRadius: 4,
      }}
    >
      {/* User badge */}
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="absolute -right-1 -top-3 flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium text-white shadow-sm"
              style={{ backgroundColor: editor.color }}
            >
              {editor.avatar ? (
                <img
                  src={editor.avatar}
                  alt={editor.name}
                  className="h-3 w-3 rounded-full"
                />
              ) : (
                <span>{getInitials(editor.name)}</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {st('sweep.weldflow.presenceIndicator.beingEditedBy', { name: editor.name })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
});
