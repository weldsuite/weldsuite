/**
 * Tells a real profile photo from a stand-in image.
 *
 * Two kinds of stand-in reach the meeting as a participant's `picture`:
 *   - Clerk's default avatar for a member who never uploaded a photo
 *     (`img.clerk.com/<base64 JSON>`, where the JSON says `"type":"default"`)
 *   - the initials SVG the platform generates for a person without a photo
 *     (`…/avatars/people/<personId>/logo.svg`)
 * Both are placeholders with their own look. The meeting draws its own
 * placeholder (initials on the person's colour), so it ignores these and every
 * participant without a photo looks the same.
 */

const GENERATED_PERSON_AVATAR = /\/avatars\/people\/[^/]+\/logo\.svg$/;

function isClerkDefaultAvatar(url: URL): boolean {
  if (url.hostname !== 'img.clerk.com') return false;
  const encoded = url.pathname.split('/').pop();
  if (!encoded) return false;
  try {
    const meta: unknown = JSON.parse(atob(decodeURIComponent(encoded)));
    return typeof meta === 'object' && meta !== null && (meta as { type?: unknown }).type === 'default';
  } catch {
    return false;
  }
}

/** The picture to show for a participant: their photo, or undefined for none / a stand-in. */
export function getRealPicture(picture: string | null | undefined): string | undefined {
  if (!picture) return undefined;
  let url: URL;
  try {
    url = new URL(picture);
  } catch {
    // Relative or otherwise unparseable: not one of the known stand-ins.
    return picture;
  }
  if (isClerkDefaultAvatar(url) || GENERATED_PERSON_AVATAR.test(url.pathname)) return undefined;
  return picture;
}
