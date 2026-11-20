import type { CSSProperties, ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useMemberAvatar } from '@/hooks/use-member-avatar';

/** First letters of the first two words: "Ada Lovelace" → "AL". */
export function memberInitials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export interface MemberAvatarProps {
  /** The member's user id (or workspace member id). The current user's own id works too. */
  userId?: string | null;
  /** Their name, for the initials and the image's alt text. */
  name?: string | null;
  /** A picture the row carries (e.g. a message's `authorAvatar`), shown until the live one loads. */
  picture?: string | null;
  /** Sizes the avatar (`size-6`, `h-8 w-8`, ...); leave the radius to the component. */
  className?: string;
  fallbackClassName?: string;
  fallbackStyle?: CSSProperties;
  /** Replaces the initials, e.g. with an icon. */
  fallback?: ReactNode;
  /** Names the image for screen readers; it is decorative (empty alt) by default. */
  alt?: string;
  title?: string;
  'aria-hidden'?: boolean;
}

/**
 * A workspace member's avatar with their current picture: the one they set in
 * profile settings, looked up by user id (see `useMemberAvatar`). Use it for
 * any teammate or for the signed-in user, instead of a picture from the row.
 */
export function MemberAvatar({
  userId,
  name,
  picture,
  className,
  fallbackClassName,
  fallbackStyle,
  fallback,
  alt,
  title,
  'aria-hidden': ariaHidden,
}: Readonly<MemberAvatarProps>) {
  const src = useMemberAvatar(userId, picture);
  return (
    <Avatar className={className} title={title} aria-hidden={ariaHidden}>
      {src && <AvatarImage src={src} alt={alt} />}
      <AvatarFallback className={fallbackClassName} style={fallbackStyle}>
        {fallback ?? memberInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
