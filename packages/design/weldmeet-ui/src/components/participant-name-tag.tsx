import { type ReactNode } from 'react';
import { MicOff, VolumeX } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ParticipantNameTagProps {
  /** Display name shown inside the tag. Pass "You" for the local participant. */
  name: string;
  /** When false, a small MicOff icon is rendered before the name. */
  audioEnabled?: boolean;
  /** When true (and audioEnabled is true), shows a VolumeX icon indicating
   *  the local viewer has muted this participant for themselves. */
  localMuted?: boolean;
  /** Override the default positioning/spacing. The default mirrors the
   *  weldmeet `ParticipantTile` (bottom-left of the tile). */
  className?: string;
  /** When provided, the name tag becomes clickable (cursor + hover state)
   *  and fires this handler. The click does not bubble to the parent tile. */
  onClick?: () => void;
  /** Optional leading icon rendered before the name (e.g. a screen icon for a
   *  screen-share tag). Size it to h-3.5 w-3.5 to match the mic affordances. */
  icon?: ReactNode;
}

/**
 * The corner label that sits on top of a participant tile / preview tile.
 * Shared so the landing preview, waitlisted preview, and in-meeting tile all
 * render the same pill with the same MicOff affordance.
 */
export function ParticipantNameTag({
  name,
  audioEnabled = true,
  localMuted = false,
  className,
  onClick,
  icon,
}: ParticipantNameTagProps) {
  return (
    <div
      className={cn(
        'absolute bottom-2 left-2 z-10 flex items-center gap-1.5 bg-black/50 backdrop-blur-sm text-white text-[13px] font-medium px-2.5 py-1 rounded-md',
        onClick && 'cursor-pointer hover:bg-black/70 transition-colors',
        className,
      )}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    >
      {icon}
      {!audioEnabled && <MicOff className="h-3.5 w-3.5" />}
      {localMuted && audioEnabled && <VolumeX className="h-3.5 w-3.5 text-red-400" />}
      <span>{name}</span>
    </div>
  );
}
