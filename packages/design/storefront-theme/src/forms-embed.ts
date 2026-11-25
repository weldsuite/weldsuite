/**
 * WeldForms embeds for the contact form section, ported from
 * site-components' `weldforms-embed.ts`: the public id must look like one
 * and the portal must be an http(s) origin, or nothing is embedded.
 */

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The public id when it looks like one; null otherwise. */
export function cleanPublicId(value: unknown): string | null {
  return typeof value === 'string' && PUBLIC_ID.test(value.trim()) ? value.trim() : null;
}

/** An http(s) origin without a trailing slash; null for anything else. */
export function portalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The form's own page on the portal, for visitors without JavaScript. */
export function formPageUrl(portal: string, publicId: string): string {
  return `${portal}/f/${encodeURIComponent(publicId)}`;
}
