/**
 * Workspace slugs as the public portals (project, help desk, HR) receive them:
 * straight from an unauthenticated request, so validated before they touch a
 * KV cache key or the master DB, and always matched exactly.
 */

/**
 * What a portal request may call a workspace: lowercase letters, digits and
 * hyphens. Workspace slugs are created lowercase (`slugifyWorkspaceName`,
 * the `updateWorkspaceSlugInput` rule `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`, and
 * Clerk org slugs), with an optional collision suffix of `-<6 chars>` or
 * `-<6 chars>-<n>` appended, so 100 characters is generous headroom. The
 * lookup stays an exact match, so this pattern is deliberately a little wider
 * than the creation rule: a stricter check would lock out a legacy slug, a
 * looser one would only let junk into the cache key and the master DB.
 */
export const PORTAL_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

/**
 * Trim, lowercase and validate a slug taken from a request. Returns null when
 * it is missing or not shaped like a workspace slug (`%`, `_`, `\`, `.`,
 * whitespace, unicode, over-long values, ...).
 */
export function normalizePortalSlug(raw: string | null | undefined): string | null {
  const slug = raw?.trim().toLowerCase();
  return slug && PORTAL_SLUG_PATTERN.test(slug) ? slug : null;
}
