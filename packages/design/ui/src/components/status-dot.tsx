import { cn } from '@weldsuite/ui/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@weldsuite/ui/components/tooltip';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export type PresenceStatus = 'online' | 'busy' | 'away' | 'dnd' | 'offline';

export const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-green-500',
  busy: 'bg-orange-500',
  dnd: 'bg-red-500',
  away: 'bg-yellow-500',
  offline: 'bg-gray-400',
};

export const STATUS_LABELS: Record<PresenceStatus, string> = {
  online: 'Available',
  busy: 'Busy',
  dnd: 'Do Not Disturb',
  away: 'Away',
  offline: 'Offline',
};

export const PRESENCE_STATUSES: PresenceStatus[] = ['online', 'busy', 'dnd', 'away', 'offline'];

const SIZE_CLASSES = {
  sm: 'h-2 w-2 border',
  md: 'h-2.5 w-2.5 border-2',
  lg: 'h-3 w-3 border-2',
};

export interface StatusDotProps {
  status?: PresenceStatus | string;
  size?: 'sm' | 'md' | 'lg';
  showTooltip?: boolean;
  className?: string;
}

export function StatusDot({ status, size = 'md', showTooltip = false, className }: StatusDotProps) {
  const resolved = (status as PresenceStatus) || 'offline';
  const color = STATUS_COLORS[resolved] || STATUS_COLORS.offline;
  const label = STATUS_LABELS[resolved] || STATUS_LABELS.offline;

  const dot = (
    <span
      className={cn('block rounded-full border-background', color, SIZE_CLASSES[size], className)}
    />
  );

  if (!showTooltip) return dot;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{dot}</TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={4}
        className="animate-in fade-in-0 zoom-in-95 duration-200"
      >
        {label}
        <TooltipPrimitive.Arrow className="fill-primary" width={8} height={4} />
      </TooltipContent>
    </Tooltip>
  );
}
