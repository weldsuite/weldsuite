import { cn } from '@weldsuite/ui/lib/utils';

export interface ParticipantAvatarProps {
  /** Initials shown when no picture is available (typically 1–2 chars). */
  initials: string;
  /** Background color for the fallback square (when no picture). */
  color: string;
  /** Picture URL — when provided an <img> is rendered instead of initials. */
  picture?: string | null;
  /** Override classes — overrides the default container-relative sizing. */
  className?: string;
}

/**
 * The "camera-off" placeholder rendered inside a participant / preview tile.
 * Shared across the landing preview, waitlisted preview, and in-meeting tile
 * so all three scale identically with their parent.
 *
 * Sizing: 28% of the parent's smallest dimension (cqmin), clamped between
 * 40px and 128px. The parent MUST declare `container-type: size` for the
 * cqmin units to resolve — without it the avatar falls back to the min size.
 */
export function ParticipantAvatar({
  initials,
  color,
  picture,
  className,
}: ParticipantAvatarProps) {
  return (
    <div
      className={cn(
        'h-[28cqmin] w-[28cqmin] min-h-10 min-w-10 max-h-32 max-w-32 rounded-[20%] flex items-center justify-center text-[clamp(0.875rem,8cqmin,2.25rem)] text-white font-mono font-medium overflow-hidden',
        className,
      )}
      style={picture ? undefined : { backgroundColor: color }}
    >
      {picture ? (
        <img src={picture} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="translate-y-px">{initials}</span>
      )}
    </div>
  );
}
