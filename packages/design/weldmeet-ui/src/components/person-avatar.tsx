import type { ComponentProps } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@weldsuite/ui/lib/utils';
import { getRealPicture } from '../lib/avatar-picture';
import { getInitialsColor, getPersonTheme } from '../lib/person-theme';

export interface PersonAvatarProps extends Omit<ComponentProps<typeof Avatar>, 'children'> {
  /** Shown as initials when there is no photo. */
  initials: string;
  /** Photo URL. Stand-in images (see `getRealPicture`) are ignored. */
  picture?: string | null;
  /** Stable id the colour is derived from: the same one the in-call tile uses. */
  colorSeed: string;
  /** Size and radius of the avatar box. */
  className?: string;
  /** Radius (again, for the image) and text size of the initials. */
  innerClassName?: string;
}

/**
 * The small avatar of a participant in the meeting's lists and menus: their
 * photo, or initials on their colour, exactly as on their in-call tile.
 */
export function PersonAvatar({ initials, picture, colorSeed, className, innerClassName, ...rest }: Readonly<PersonAvatarProps>) {
  const photo = getRealPicture(picture);
  const color = getPersonTheme(colorSeed).avatar;
  return (
    <Avatar className={className} {...rest}>
      {photo && <AvatarImage src={photo} className={innerClassName} />}
      <AvatarFallback
        className={cn('font-sans font-semibold', innerClassName)}
        style={{ backgroundColor: color, color: getInitialsColor(color) }}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
