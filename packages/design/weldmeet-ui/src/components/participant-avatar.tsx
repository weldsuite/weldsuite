import { cn } from '@weldsuite/ui/lib/utils';
import { getRealPicture } from '../lib/avatar-picture';
import { getInitialsColor } from '../lib/person-theme';

export interface ParticipantAvatarProps {
  /** Initials shown when no picture is available (typically 1–2 chars). */
  initials: string;
  /** Background color for the fallback square (when no picture). */
  color: string;
  /** Photo URL — rendered instead of the initials. Stand-in images (Clerk's
   *  default avatar, the generated initials SVG) are ignored. */
  picture?: string | null;
  /**
   * `preview` (default) is the large pre-join placeholder; `tile` is the
   * smaller, rounder one of an in-meeting tile.
   */
  size?: 'preview' | 'tile';
  /** Override classes — overrides the default container-relative sizing. */
  className?: string;
}

/**
 * Box of the in-meeting camera-off avatar: smaller and rounder than the
 * default (28cqmin, max 128px, 20% radius; this one is 38%). Exported for the ringing halo,
 * which shares the box.
 */
export const TILE_AVATAR_BOX = 'h-[21cqmin] w-[21cqmin] max-h-24 max-w-24 rounded-[38%]';

/**
 * The "camera-off" placeholder rendered inside a participant / preview tile.
 * Shared across the landing preview, waitlisted preview, and in-meeting tile.
 *
 * Sizing: 28% of the parent's smallest dimension (cqmin), clamped between
 * 40px and 128px. `size="tile"` is the smaller in-meeting box. The
 * parent MUST declare `container-type: size` for the cqmin units to resolve —
 * without it the avatar falls back to the min size.
 */
export function ParticipantAvatar({
  initials,
  color,
  picture,
  size = 'preview',
  className,
}: Readonly<ParticipantAvatarProps>) {
  const photo = getRealPicture(picture);
  return (
    <div
      className={cn(
        'h-[28cqmin] w-[28cqmin] min-h-10 min-w-10 max-h-32 max-w-32 rounded-[20%] flex items-center justify-center text-[clamp(1rem,10.5cqmin,3rem)] font-sans font-semibold overflow-hidden',
        size === 'tile' && cn(TILE_AVATAR_BOX, 'text-[clamp(0.875rem,8cqmin,2.25rem)]'),
        className,
      )}
      style={photo ? undefined : { backgroundColor: color, color: getInitialsColor(color) }}
    >
      {photo ? (
        <img src={photo} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="translate-y-px">{initials}</span>
      )}
    </div>
  );
}
